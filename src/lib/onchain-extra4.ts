/**
 * new-tokens — the freshest Base DEX pools, the Base fresh-launch feed (the
 * ax1.vc model: a cheap feed a sniper polls in a tight loop). GeckoTerminal
 * new_pools, keyless, with each pool's address, age, liquidity, 24h volume and
 * price. Loop-friendly: pass `since=<cursor>` to get only pools created since
 * your last poll and read `cursor` back. Throws on upstream failure so x402
 * doesn't charge for an empty answer.
 */

import "server-only";

interface BasePool {
  address: string;
  name: string;
  createdAt: string;
  ageMinutes: number;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceUsd: number | null;
}

/** Freshest Base DEX pools (GeckoTerminal new_pools), newest first. null = upstream down. */
async function baseNewPools(pages = 2): Promise<BasePool[] | null> {
  const out: BasePool[] = [];
  let anyOk = false;
  const nowMs = Date.now();
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  for (let page = 1; page <= pages; page++) {
    try {
      const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=${page}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      anyOk = true;
      const j = (await res.json()) as {
        data?: Array<{ attributes?: Record<string, unknown>; relationships?: { base_token?: { data?: { id?: string } } } }>;
      };
      for (const p of j.data ?? []) {
        const a = p.attributes ?? {};
        const id = String(p.relationships?.base_token?.data?.id ?? ""); // "base_0x…"
        const address = id.includes("_") ? id.split("_")[1] : "";
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
        const createdAt = String(a.pool_created_at ?? "");
        out.push({
          address,
          name: String(a.name ?? ""),
          createdAt,
          ageMinutes: createdAt ? Math.round((nowMs - Date.parse(createdAt)) / 60000) : -1,
          liquidityUsd: num(a.reserve_in_usd),
          volume24hUsd: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
          priceUsd: num(a.base_token_price_usd),
        });
      }
    } catch {
      /* best-effort per page */
    }
  }
  if (!anyOk) return null; // every page failed → upstream down → caller refunds
  const seen = new Set<string>();
  return out
    .filter((p) => {
      const k = p.address.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
}

/** Parse an ISO `since` cursor → epoch ms, or null. Lets an agent poll for deltas. */
function sinceMs(params: Record<string, string>): number | null {
  const raw = (params.since || "").trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}
/** Newest `createdAt` across the feed → the cursor to pass back next poll. */
function newestCursor(pools: { createdAt?: string }[], prev?: string): string | null {
  let max = prev ? Date.parse(prev) : 0;
  for (const p of pools) {
    const t = p.createdAt ? Date.parse(p.createdAt) : 0;
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max ? new Date(max).toISOString() : prev || null;
}

export async function newTokens(params: Record<string, string>) {
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 40);
  const minLiq = Math.max(Number(params.minLiquidityUsd) || 0, 0);
  const since = sinceMs(params);
  const pools = await baseNewPools(2);
  if (pools === null) throw new Error("Base new-pools feed unavailable — not charged; retry shortly.");
  const cursor = newestCursor(pools, params.since);
  let pairs = pools.filter((p) => (p.liquidityUsd ?? 0) >= minLiq);
  if (since != null) pairs = pairs.filter((p) => p.createdAt && Date.parse(p.createdAt) > since);
  pairs = pairs.slice(0, limit);
  return {
    chain: "base" as const,
    count: pairs.length,
    cursor,
    headline:
      since != null
        ? `${pairs.length} NEW Base pool${pairs.length === 1 ? "" : "s"} since your last poll.`
        : `${pairs.length} fresh Base pool${pairs.length === 1 ? "" : "s"}, newest ${pairs[0]?.ageMinutes ?? "?"}m old.`,
    note: "New ≠ safe — run token-verdict or pre-trade-gate on an address before buying. Poll with ?since=<cursor> to get only pools created since your last call.",
    pairs,
    source: "GeckoTerminal new-pools (Base)",
    checkedAt: new Date().toISOString(),
  };
}
