/**
 * x402 market intelligence — what the Bazaar holds for a capability, and the real
 * demand behind it.
 *
 * The CDP discovery index is the directory agents search, and each indexed
 * resource carries a quality block the index computes itself: 30-day total calls
 * and unique payers. That is actual demand, not a guess — so a builder deciding
 * what to ship, or an agent picking among providers, can see which capabilities
 * are busy and crowded versus thin, and (with a payTo) where a given seller sits.
 *
 * Reads the public discovery/search endpoint (the same one index-health uses,
 * no auth), aggregates the matches for a query, and reports price distribution,
 * networks, distinct sellers and the demand totals. Honest about its source: the
 * index returns partialResults and is known to under-report (the project has
 * filed issues on its completeness), so counts are a floor — "at least this
 * many", never "exactly". A failed read is surfaced, never reported as "none".
 */

import "server-only";
import { USDC_BASE } from "./config";

const SEARCH = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";

interface Accept { amount?: string; network?: string; payTo?: string; asset?: string }
interface Resource {
  resource?: string;
  url?: string;
  description?: string;
  curated?: boolean;
  accepts?: Accept[];
  quality?: { l30DaysTotalCalls?: number; l30DaysUniquePayers?: number; lastCalledAt?: string };
}

/** USDC atomic amount (6 decimals) → USD number, or null for a non-USDC accept. */
function usd(accept: Accept | undefined): number | null {
  if (!accept?.amount || !accept.asset) return null;
  if (accept.asset.toLowerCase() !== USDC_BASE.toLowerCase()) return null;
  try { return Number(BigInt(accept.amount)) / 1e6; } catch { return null; }
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(6);
};

export async function x402MarketIntel(params: Record<string, string>) {
  const query = (params.query || params.q || params.capability || "").trim();
  if (!query) throw new Error("Provide a capability/keyword to search the x402 index for (query=…, e.g. 'token safety')");
  const payTo = (params.payTo || params.seller || "").trim();

  const url = `${SEARCH}?query=${encodeURIComponent(query)}${payTo ? `&payTo=${encodeURIComponent(payTo)}` : ""}&limit=200`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    return degraded(query, "discovery index unreachable this call");
  }
  if (!res.ok) return degraded(query, `discovery index returned HTTP ${res.status}`);
  let body: { resources?: Resource[]; partialResults?: boolean };
  try { body = await res.json(); } catch { return degraded(query, "discovery index returned an unreadable body"); }

  const resources = body.resources ?? [];
  const prices: number[] = [];
  const sellers = new Set<string>();
  const networks = new Set<string>();
  let totalCalls = 0, totalPayers = 0, curated = 0, withDemand = 0;

  const ranked = resources.map((r) => {
    const a0 = r.accepts?.[0];
    const price = usd(a0);
    if (price !== null) prices.push(price);
    for (const a of r.accepts ?? []) { if (a.payTo) sellers.add(a.payTo.toLowerCase()); if (a.network) networks.add(a.network); }
    if (r.curated) curated++;
    const calls = r.quality?.l30DaysTotalCalls ?? 0;
    const payers = r.quality?.l30DaysUniquePayers ?? 0;
    if (calls > 0) withDemand++;
    totalCalls += calls;
    totalPayers += payers;
    return {
      resource: r.resource || r.url || null,
      description: r.description ? r.description.slice(0, 140) : null,
      priceUsd: price,
      curated: Boolean(r.curated),
      l30dCalls: calls,
      l30dUniquePayers: payers,
    };
  }).sort((a, b) => b.l30dCalls - a.l30dCalls);

  const ours = payTo ? ranked.length : null;

  return {
    query,
    ...(payTo ? { payTo } : {}),
    matches: resources.length,
    partial: Boolean(body.partialResults),
    distinctSellers: sellers.size,
    networks: [...networks],
    priceUsd: { min: prices.length ? Math.min(...prices) : null, median: median(prices), max: prices.length ? Math.max(...prices) : null },
    demand30d: { totalCalls, totalUniquePayers: totalPayers, resourcesWithAnyCalls: withDemand },
    top: ranked.slice(0, 10),
    ...(payTo ? { yourResources: ours } : {}),
    finding:
      resources.length === 0
        ? `The discovery index returned no matches for "${query}" right now. It under-reports (partialResults), so this is "none surfaced", not "none exist".`
        : `At least ${resources.length} indexed resource(s) match "${query}" across ${sellers.size} seller(s); ${withDemand} have taken a call in the last 30 days (${totalCalls} calls, ${totalPayers} unique payers total). Prices from $${prices.length ? Math.min(...prices) : "?"} to $${prices.length ? Math.max(...prices) : "?"}.`,
    note: "x402 market intelligence from the CDP discovery index (the directory agents search). Demand (30-day calls / unique payers) is the index's own quality metric — real, not inferred. The index returns partial results and is known to under-report, so counts are a FLOOR. Pass payTo to scope to one seller. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

function degraded(query: string, reason: string) {
  return {
    query,
    degraded: true,
    verdict: "unknown",
    note: `⚠️ ${reason} — the x402 index could not be read, so demand/competition for "${query}" is UNKNOWN this call, not zero. Re-check.`,
    checkedAt: new Date().toISOString(),
  };
}
