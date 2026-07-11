/**
 * Shared, KV-cached fetchers for the two free upstreams that many services hit —
 * GoPlus token-security and DexScreener token pairs. Every GoPlus caller used the
 * identical URL, and composites (sellability, rug-score, deep-dd) hit it 2× per
 * paid call; caching de-duplicates those, halves composite latency, and makes
 * GoPlus rate-limit (429) failures near-impossible — a 429 on a PAID call is a
 * churned customer. In-memory + KV; both return null on failure so callers keep
 * their existing fallback behavior.
 */

import "server-only";
import { kvGet, kvSet } from "./kv";

// Process-local micro-cache (bridges the sub-second window within one composite
// call before/without KV, and cuts KV round-trips on hot addresses).
const mem = new Map<string, { at: number; v: unknown }>();
const MEM_TTL_MS = 45_000;

async function cached<T>(key: string, ttlSec: number, fetcher: () => Promise<T | null>): Promise<T | null> {
  const m = mem.get(key);
  if (m && Date.now() - m.at < MEM_TTL_MS) return m.v as T | null;
  try {
    const hit = await kvGet(key);
    if (hit !== null) {
      const v = JSON.parse(hit) as T;
      mem.set(key, { at: Date.now(), v });
      return v;
    }
  } catch {
    /* KV miss/down → fetch */
  }
  const v = await fetcher();
  if (v !== null) {
    mem.set(key, { at: Date.now(), v });
    try {
      await kvSet(key, JSON.stringify(v), ttlSec);
    } catch {
      /* best-effort */
    }
  }
  return v;
}

/** GoPlus token-security row for a Base token (honeypot/taxes/holders/LP…). null on failure. */
export async function goPlusSecurity<T = Record<string, unknown>>(address: string): Promise<T | null> {
  const addr = address.toLowerCase();
  return cached<T>(`gp:${addr}`, 90, async () => {
    try {
      const r = await fetch(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${addr}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { result?: Record<string, T> };
      const row = j.result?.[addr];
      return row && Object.keys(row as object).length > 0 ? row : null;
    } catch {
      return null;
    }
  });
}

/** DexScreener pairs for a token (latest/dex/tokens/{addr}). Returns the raw pairs array; null on failure. */
export async function dexTokenPairs<T = unknown>(address: string): Promise<T[] | null> {
  const addr = address.toLowerCase();
  return cached<T[]>(`dex:${addr}`, 45, async () => {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { pairs?: T[] | null };
      return j.pairs ?? [];
    } catch {
      return null;
    }
  });
}
