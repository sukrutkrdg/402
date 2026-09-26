/**
 * NearBlocks API — the NEAR indexer, for what the RPC cannot answer: an
 * account's history and a token's holder list. The RPC only knows current
 * state; anything "over time" or "across all accounts" needs an indexer.
 *
 * Shapes follow NearBlocks' own API source (apps/api in Nearblocks/nearblocks).
 * Without a key the public API is rate-limited per IP; set NEARBLOCKS_API_KEY
 * for the paid tier. Answers are cached for a minute so a burst of identical
 * calls costs one upstream request. Every failure throws a "not charged"
 * message — the route refunds on any handler error.
 */

import "server-only";

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

export function _resetNearblocksCache() {
  cache.clear();
}

function base(): string {
  return (process.env.NEARBLOCKS_API_URL || "https://api.nearblocks.io").replace(/\/+$/, "");
}

export async function nearblocks<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.NEARBLOCKS_API_KEY) headers.authorization = `Bearer ${process.env.NEARBLOCKS_API_KEY}`;
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error("NEAR indexer (NearBlocks) unreachable — not charged, retry shortly");
  }
  if (res.status === 429) throw new Error("NEAR indexer (NearBlocks) rate limit — not charged, retry in a minute");
  if (!res.ok) throw new Error(`NEAR indexer (NearBlocks) error ${res.status} — not charged, retry shortly`);
  let value: T;
  try {
    value = (await res.json()) as T;
  } catch {
    throw new Error("NEAR indexer (NearBlocks) sent an unreadable answer — not charged, retry shortly");
  }
  cache.set(path, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}

/** NearBlocks timestamps are nanoseconds since epoch, as a string or number. */
export function nsToIso(ns: unknown): string | null {
  const s = String(ns ?? "");
  if (!/^\d{13,}$/.test(s)) return null;
  const ms = Number(s.slice(0, s.length - 6));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** An integer amount that may arrive as a string, a number, or in exponent form. */
export function toBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v).toLocaleString("en-US", { useGrouping: false }));
  const s = String(v ?? "").trim();
  if (/^-?\d+$/.test(s)) return BigInt(s);
  const n = Number(s);
  return Number.isFinite(n) ? BigInt(Math.trunc(n).toLocaleString("en-US", { useGrouping: false })) : null;
}
