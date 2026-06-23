/**
 * Best-effort free tier: N free calls per IP per day, to let agents try before
 * they pay (an adoption funnel — not a hard security boundary).
 *
 * In-memory + per-instance, so on serverless it resets on cold start and isn't
 * shared across instances. Keep the quota small. For hard global enforcement,
 * back this with a KV store (Vercel KV / Upstash) — same function signatures.
 */

import "server-only";

const counts = new Map<string, { day: string; n: number }>();

export function freeLimit(): number {
  const n = parseInt(process.env.FREE_TIER_DAILY || "3", 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Try to consume one free call for this key. */
export function consumeFree(key: string): { allowed: boolean; remaining: number; limit: number } {
  const limit = freeLimit();
  if (limit <= 0) return { allowed: false, remaining: 0, limit };
  const day = today();
  const rec = counts.get(key);
  const used = rec && rec.day === day ? rec.n : 0;
  if (used >= limit) return { allowed: false, remaining: 0, limit };
  counts.set(key, { day, n: used + 1 });
  return { allowed: true, remaining: limit - (used + 1), limit };
}

export function freeRemaining(key: string): { remaining: number; limit: number } {
  const limit = freeLimit();
  const day = today();
  const rec = counts.get(key);
  const used = rec && rec.day === day ? rec.n : 0;
  return { remaining: Math.max(0, limit - used), limit };
}
