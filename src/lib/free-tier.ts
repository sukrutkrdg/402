/**
 * Free tier: N free calls per IP per day, to let agents try before they pay.
 *
 * Backed by the KV layer (src/lib/kv.ts): durable & globally consistent when KV
 * is configured, in-memory fallback otherwise. AI services are excluded from the
 * free tier at the route level (they have real upstream cost).
 */

import "server-only";
import { kvIncr, kvGetNumber } from "./kv";

export function freeLimit(): number {
  // One free trial call per IP per day — a taste to convert, not a giveaway.
  const n = parseInt(process.env.FREE_TIER_DAILY || "1", 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

function dayKey(key: string): string {
  return `free:${key}:${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Atomically consume one free call for this key (per day).
 *
 * `degraded` distinguishes the two reasons for a refusal, and the caller has to
 * care. "You already used today's call" is a normal outcome that earns a
 * preview. "We could not count" means nothing downstream can be metered either
 * — the preview cache is in the same KV, and the preview limiter falls back to
 * a per-instance counter that a cold start resets — so treating it like a used
 * quota hands out unmetered work instead of denying it.
 */
export async function consumeFree(
  key: string,
): Promise<{ allowed: boolean; remaining: number; limit: number; degraded: boolean }> {
  const limit = freeLimit();
  if (limit <= 0) return { allowed: false, remaining: 0, limit, degraded: false };
  const n = await kvIncr(dayKey(key), 86400); // expires after 24h
  // FAIL CLOSED: if the counter can't be read (KV outage / quota exhausted) we
  // can't know whether this caller already used their free call — deny the
  // freebie rather than open an unlimited free tier. Paying is unaffected.
  if (n === null) return { allowed: false, remaining: 0, limit, degraded: true };
  if (n > limit) return { allowed: false, remaining: 0, limit, degraded: false };
  return { allowed: true, remaining: limit - n, limit, degraded: false };
}

export async function freeRemaining(key: string): Promise<{ remaining: number; limit: number }> {
  const limit = freeLimit();
  const used = await kvGetNumber(dayKey(key));
  return { remaining: Math.max(0, limit - used), limit };
}
