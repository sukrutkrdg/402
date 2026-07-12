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
// call before/without KV, and cuts KV round-trips on hot addresses). Entries
// carry the ORIGINAL fetch time and expire on the same deadline as the KV row —
// re-stamping a near-expiry KV hit into mem would quietly extend price/honeypot
// staleness past the 45/90s windows callers (and receipts) reason about.
const mem = new Map<string, { fetchedAt: number; expiresAt: number; v: unknown }>();
const MEM_MAX = 500; // per-instance cap — address-scanning traffic must not grow this unbounded

function memSet(key: string, fetchedAt: number, ttlSec: number, v: unknown) {
  if (mem.size >= MEM_MAX) {
    // Cheap eviction: drop the oldest-inserted half. Map preserves insertion order.
    let n = Math.floor(MEM_MAX / 2);
    for (const k of mem.keys()) {
      if (n-- <= 0) break;
      mem.delete(k);
    }
  }
  mem.set(key, { fetchedAt, expiresAt: fetchedAt + ttlSec * 1000, v });
}

// KV rows are wrapped {at, v} so a KV hit knows its true age. Bare legacy rows
// (pre-wrapper) parse as v-with-unknown-age and are treated as expiring now.
async function cached<T>(key: string, ttlSec: number, fetcher: () => Promise<T | null>): Promise<T | null> {
  const m = mem.get(key);
  if (m && Date.now() < m.expiresAt) return m.v as T | null;
  try {
    const hit = await kvGet(key);
    if (hit !== null) {
      const parsed = JSON.parse(hit) as { at?: number; v?: T } | T;
      const wrapped = parsed !== null && typeof parsed === "object" && "at" in (parsed as object) && "v" in (parsed as object);
      const v = wrapped ? (parsed as { v: T }).v : (parsed as T);
      const at = wrapped ? (parsed as { at: number }).at : 0;
      if (at > 0) memSet(key, at, ttlSec, v);
      return v;
    }
  } catch {
    /* KV miss/down → fetch */
  }
  const v = await fetcher();
  if (v !== null) {
    const now = Date.now();
    memSet(key, now, ttlSec, v);
    try {
      await kvSet(key, JSON.stringify({ at: now, v }), ttlSec);
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
