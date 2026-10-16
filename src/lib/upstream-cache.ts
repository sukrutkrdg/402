/**
 * Shared, KV-cached fetchers and resilient fallback layer for third-party public upstreams:
 * - GoPlus token security
 * - DexScreener token pairs & pool snapshots
 * - CoinGecko derivatives, trending, global, and top markets
 *
 * Architecture:
 * 1. L1 In-Memory Micro-Cache: Sub-millisecond reads within instance lifecycle.
 * 2. L2 Upstash KV: Shared cache across serverless instances with TTL.
 * 3. Stale-While-Revalidate / 429 Fallback: When upstream encounters rate limits (429)
 *    or transient network failure, returns recent stale cached data rather than failing
 *    paid customer requests.
 * 4. Circuit Breaker: Automatically backs off requests to overloaded upstreams to avoid
 *    extending IP rate-limit bans.
 */

import { goPlusHeaders, invalidateGoPlusToken, noteAuthedGoPlusCall } from "./goplus-auth";
import "server-only";
import { kvGet, kvSet } from "./kv";

interface MemEntry<T = unknown> {
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
  v: T;
}

const mem = new Map<string, MemEntry>();
const MEM_MAX = 500;
const circuitBreakers = new Map<string, number>(); // domain -> backoffUntilTimestamp

export function clearUpstreamCache(): void {
  mem.clear();
  circuitBreakers.clear();
}

function memSet(key: string, fetchedAt: number, ttlSec: number, staleGraceSec: number, v: unknown) {
  if (mem.size >= MEM_MAX) {
    let n = Math.floor(MEM_MAX / 2);
    for (const k of mem.keys()) {
      if (n-- <= 0) break;
      mem.delete(k);
    }
  }
  mem.set(key, {
    fetchedAt,
    expiresAt: fetchedAt + ttlSec * 1000,
    staleUntil: fetchedAt + (ttlSec + staleGraceSec) * 1000,
    v,
  });
}

function isCircuitOpen(domain?: string): boolean {
  if (!domain) return false;
  const backoffUntil = circuitBreakers.get(domain);
  if (!backoffUntil) return false;
  if (Date.now() < backoffUntil) return true;
  circuitBreakers.delete(domain);
  return false;
}

function tripCircuit(domain?: string, backoffSec = 15): void {
  if (domain) {
    circuitBreakers.set(domain, Date.now() + backoffSec * 1000);
  }
}

function isCacheEnabled(): boolean {
  if (process.env.ENABLE_UPSTREAM_CACHE_IN_TESTS === "true") return true;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

export async function cached<T>(
  key: string,
  ttlSec: number,
  fetcher: () => Promise<T | null>,
  opts: { staleGraceSec?: number; domain?: string } = {}
): Promise<T | null> {
  if (!isCacheEnabled()) {
    return await fetcher();
  }

  const staleGraceSec = opts.staleGraceSec ?? Math.max(ttlSec * 4, 120);

  const m = mem.get(key) as MemEntry<T> | undefined;
  if (m && Date.now() < m.expiresAt) {
    return m.v;
  }

    // Check circuit breaker before hitting network
    if (isCircuitOpen(opts.domain)) {
      if (m && Date.now() < m.staleUntil) {
        return m.v;
      }
    }

    try {
      const hit = await kvGet(key);
      if (hit !== null) {
        const parsed = JSON.parse(hit) as { at?: number; v?: T } | T;
        const wrapped = parsed !== null && typeof parsed === "object" && "at" in (parsed as object) && "v" in (parsed as object);
        const v = wrapped ? (parsed as { v: T }).v : (parsed as T);
        const at = wrapped ? (parsed as { at: number }).at : 0;
        if (at > 0) {
          const age = Date.now() - at;
          if (age < ttlSec * 1000) {
            memSet(key, at, ttlSec, staleGraceSec, v);
            return v;
          }
        }
      }
    } catch {
      /* KV miss or down */
    }

  // Attempt fetch
  try {
    const v = await fetcher();
    if (v !== null) {
      const now = Date.now();
      memSet(key, now, ttlSec, staleGraceSec, v);
      try {
        await kvSet(key, JSON.stringify({ at: now, v }), ttlSec + staleGraceSec);
      } catch {
        /* best-effort */
      }
      return v;
    }
  } catch (err: unknown) {
    const errMsg = (err as Error)?.message ?? "";
    const isRateLimited = errMsg.includes("429") || (err as { status?: number })?.status === 429;
    if (isRateLimited) {
      tripCircuit(opts.domain, 20);
    }

    const stale = mem.get(key) as MemEntry<T> | undefined;
    if (stale && Date.now() < stale.staleUntil) {
      return stale.v;
    }
    throw err;
  }

  // If fetcher returned null, check for stale cache as fallback
  const stale = mem.get(key) as MemEntry<T> | undefined;
  if (stale && Date.now() < stale.staleUntil) {
    return stale.v;
  }
  return null;
}

const goPlusInflight = new Map<string, Promise<unknown>>();

/** GoPlus token-security row for a Base token (honeypot/taxes/holders/LP…). null on failure. */
export async function goPlusSecurity<T = Record<string, unknown>>(address: string): Promise<T | null> {
  const addr = address.toLowerCase();
  // One request per token at a time. pre-trade-bundle runs four checks on the
  // same token in parallel and each one asked GoPlus separately; under that
  // burst GoPlus answers some of them non-OK, the check reads "feed
  // unavailable", and the bundle refuses. owner-powers, token-risk and
  // sellability failed 5 of 14 calls in a day that way while each passed alone.
  const inflight = goPlusInflight.get(addr) as Promise<T | null> | undefined;
  if (inflight) return inflight;
  const p = goPlusSecurityOnce<T>(addr).finally(() => goPlusInflight.delete(addr));
  goPlusInflight.set(addr, p);
  return p;
}

async function goPlusSecurityOnce<T>(addr: string): Promise<T | null> {
  return cached<T>(
    `gp:${addr}`,
    90,
    async () => {
      try {
        const url = `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${addr}`;
        // Our registered app's quota when configured (goplus-auth.ts), anonymous otherwise.
        let headers = await goPlusHeaders();
        if (headers.authorization) noteAuthedGoPlusCall();
        let r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        // A rate limit or a 5xx is usually gone a second later: one retry.
        if (r.status === 429 || r.status >= 500) {
          await new Promise((res) => setTimeout(res, 1200));
          r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        }
        if (!r.ok) return null;
        let j = (await r.json()) as { code?: number; result?: Record<string, T> };
        // A token GoPlus no longer accepts (4012): drop it and ask once without.
        if (j.code === 4012 && headers.authorization) {
          invalidateGoPlusToken();
          headers = {};
          r = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (!r.ok) return null;
          j = (await r.json()) as { code?: number; result?: Record<string, T> };
        }
        const row = j.result?.[addr] as Record<string, unknown> | undefined;
        // GoPlus answers `code: 3` with a partial row (no is_honeypot, no owner
        // powers) while it is still analysing a token. Downstream, a missing flag
        // reads as "false", so a partial row would certify a token it never
        // checked. Treat it as no answer.
        if (!row || row.is_honeypot === undefined) return null;
        return row as T;
      } catch {
        return null;
      }
    },
    { staleGraceSec: 0, domain: "api.gopluslabs.io" }
  );
}

/** DexScreener pairs for a token (latest/dex/tokens/{addr}). Returns the raw pairs array; null on failure. */
export async function dexTokenPairs<T = unknown>(address: string): Promise<T[] | null> {
  const addr = address.toLowerCase();
  return cached<T[]>(
    `dex:${addr}`,
    45,
    async () => {
      try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { pairs?: T[] | null };
        // This endpoint returns pairs from every chain. The same address can be a
        // liquid token elsewhere (0x4200…0042 is OP on Optimism) and a different
        // contract on Base, so foreign pools would vouch for a Base token.
        return (j.pairs ?? []).filter((p) => (p as { chainId?: string }).chainId === "base");
      } catch {
        return null;
      }
    },
    { staleGraceSec: 0, domain: "api.dexscreener.com" }
  );
}

/** DexScreener pair details by pair address on Base. Cached 45s; no stale fallback — receipts rely on fresh price/liquidity. */
export async function dexPair<T = unknown>(pairAddress: string): Promise<T | null> {
  const p = pairAddress.toLowerCase();
  return cached<T>(
    `dex:pair:${p}`,
    45,
    async () => {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/base/${p}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
      } catch {
        return null;
      }
    },
    { staleGraceSec: 0, domain: "api.dexscreener.com" }
  );
}

export interface CoinGeckoDerivRow {
  market?: string;
  symbol?: string;
  index_id?: string;
  price?: string;
  basis?: number;
  funding_rate?: number;
  open_interest?: number;
  volume_24h?: number;
  contract_type?: string;
}

/**
 * CoinGecko perpetuals derivatives feed with rate-limit protection and stale fallback.
 * Cached 60s, stale grace up to 300s (5 minutes).
 */
export async function coinGeckoDerivatives(): Promise<CoinGeckoDerivRow[]> {
  const result = await cached<CoinGeckoDerivRow[]>(
    "cg:derivatives",
    60,
    async () => {
      let res: Response;
      try {
        res = await fetch("https://api.coingecko.com/api/v3/derivatives?include_tickers=unexpired", {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(12_000),
        });
      } catch {
        throw new Error("Derivatives data unreachable (CoinGecko) — not charged, retry shortly");
      }
      if (res.status === 429) {
        throw new Error("Derivatives data rate-limited upstream — not charged, retry shortly");
      }
      if (!res.ok) {
        throw new Error(`CoinGecko responded ${res.status} — not charged`);
      }
      const data = (await res.json()) as CoinGeckoDerivRow[];
      if (!Array.isArray(data)) {
        throw new Error("Derivatives data returned an unexpected shape — not charged");
      }
      return data;
    },
    { staleGraceSec: 300, domain: "api.coingecko.com" }
  );
  return result ?? [];
}

/**
 * CoinGecko globally trending coins feed with rate-limit protection and stale fallback.
 * Cached 120s, stale grace up to 600s (10 minutes).
 */
export async function coinGeckoTrending<T = unknown>(): Promise<T> {
  const result = await cached<T>(
    "cg:trending",
    120,
    async () => {
      let res: Response;
      try {
        res = await fetch("https://api.coingecko.com/api/v3/search/trending", {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new Error("Trending source unreachable (CoinGecko) — not charged, retry shortly");
      }
      if (res.status === 429) {
        throw new Error("CoinGecko responded 429 — not charged");
      }
      if (!res.ok) {
        throw new Error(`CoinGecko responded ${res.status} — not charged`);
      }
      return (await res.json()) as T;
    },
    { staleGraceSec: 600, domain: "api.coingecko.com" }
  );
  if (!result) {
    throw new Error("Trending source unreachable (CoinGecko) — not charged, retry shortly");
  }
  return result;
}
