/**
 * Minimal in-memory sliding-window rate limiter.
 *
 * Per-instance only (resets on cold start, not shared across serverless
 * instances) — enough to blunt accidental spamming of the spending endpoint.
 * For hard guarantees on a public deploy, front it with a shared store.
 */

import { kvIncr, kvConfigured } from "./kv";

const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    const retryAfterMs = windowMs - (now - arr[0]);
    hits.set(key, arr);
    return { ok: false, retryAfterMs };
  }
  arr.push(now);
  hits.set(key, arr);
  return { ok: true, retryAfterMs: 0 };
}

/**
 * Durable, cross-instance rate limiter backed by the KV/Redis layer (fixed
 * window). Falls back to the per-instance in-memory limiter when KV isn't
 * configured, so behaviour degrades gracefully instead of failing open on a
 * broken KV. Use this for security-relevant limits (spend + paid routes) where
 * the per-instance limiter's `limit × instances` effective cap is too weak.
 */
export async function rateLimitKv(
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ ok: boolean; retryAfterMs: number }> {
  if (!kvConfigured()) return rateLimit(key, limit, windowSec * 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSec / windowSec);
  const n = await kvIncr(`rl:${key}:${bucket}`, windowSec);
  // KV unreachable (kvIncr never throws — it returns null) → fall back to the
  // per-instance limiter so an outage degrades to a weaker limit, not to none.
  if (n === null) return rateLimit(key, limit, windowSec * 1000);
  if (n > limit) {
    const retryAfterMs = (windowSec - (nowSec % windowSec)) * 1000;
    return { ok: false, retryAfterMs };
  }
  return { ok: true, retryAfterMs: 0 };
}

export function clientIp(req: Request): string {
  // On Vercel, x-vercel-forwarded-for is set by the platform and is the
  // trustworthy client IP. x-forwarded-for is client-spoofable, so prefer the
  // platform headers first.
  const vercel = req.headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}
