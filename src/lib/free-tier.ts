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
  const n = parseInt(process.env.FREE_TIER_DAILY || "3", 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

function dayKey(key: string): string {
  return `free:${key}:${new Date().toISOString().slice(0, 10)}`;
}

/** Atomically consume one free call for this key (per day). */
export async function consumeFree(key: string): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const limit = freeLimit();
  if (limit <= 0) return { allowed: false, remaining: 0, limit };
  const n = await kvIncr(dayKey(key), 86400); // expires after 24h
  if (n > limit) return { allowed: false, remaining: 0, limit };
  return { allowed: true, remaining: limit - n, limit };
}

export async function freeRemaining(key: string): Promise<{ remaining: number; limit: number }> {
  const limit = freeLimit();
  const used = await kvGetNumber(dayKey(key));
  return { remaining: Math.max(0, limit - used), limit };
}
