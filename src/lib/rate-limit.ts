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
  /**
   * Cloudflare first, because it is in front of Vercel and that changes who
   * "the client" is.
   *
   * 402.com.tr is proxied through Cloudflare, so the connection Vercel sees
   * comes from a Cloudflare edge server — and `x-vercel-forwarded-for`
   * faithfully reports that edge, not the caller. Cloudflare's PoPs and
   * connections vary, so every request could arrive under a different identity.
   *
   * Measured on 2026-09-14: four consecutive free-tier calls from one machine
   * each came back `x-free-tier: true, x-free-remaining: 0` — each was counted
   * as somebody's first call of the day. `cf-cache-status: DYNAMIC` and
   * `x-vercel-cache: MISS` on all of them, so nothing was cached; the counter
   * was simply writing a fresh key every time.
   *
   * Two things were silently ineffective, not one. The free tier promises one
   * call per IP per day on every surface we publish, and was giving them away
   * without limit. The per-IP rate limit that exists to blunt a DoS was
   * bucketing by edge connection, which is close to no limit at all. Both read
   * this function.
   *
   * `cf-connecting-ip` is safe to trust here specifically because Cloudflare
   * overwrites it on every proxied request; a caller cannot forge it while
   * coming through the proxy, and the proxy is the only path to this hostname.
   * The Vercel header stays as the fallback for any deployment not behind
   * Cloudflare.
   */
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const vercel = req.headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}
