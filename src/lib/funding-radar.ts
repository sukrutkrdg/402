/**
 * funding-radar — where is the crowd? perp-funding answers "how is BTC's funding";
 * this scans the WHOLE perp market and ranks the most crowded longs and shorts by
 * funding, so a trading agent can find squeeze / mean-reversion setups in one call.
 *
 * Extreme positive funding = longs paying heavily = crowded long = vulnerable to a
 * long-squeeze on a dip. Extreme negative = crowded short = short-squeeze fuel on a
 * pump. The edges of the funding distribution are where the reflexive moves start.
 *
 * One CoinGecko derivatives read (no key), grouped by coin, OI-weighted, filtered
 * to a liquidity floor so a $100k ghost perp doesn't top the list. A market-
 * structure signal, not a price call. Not financial advice.
 */

import "server-only";

const CG = "https://api.coingecko.com/api/v3";

interface Deriv {
  index_id?: string;
  basis?: number;
  funding_rate?: number;
  open_interest?: number;
  contract_type?: string;
}

export async function fundingRadar(params: Record<string, string>) {
  const minOiUsd = Math.max(1_000_000, Number(params.minOi ?? params.minOiUsd) || 25_000_000);
  const topN = Math.min(Math.max(Number(params.limit) || 8, 3), 15);

  let res: Response;
  try {
    res = await fetch(`${CG}/derivatives?include_tickers=unexpired`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new Error("Derivatives data unreachable (CoinGecko) — not charged, retry shortly");
  }
  if (res.status === 429) throw new Error("Derivatives data rate-limited upstream — not charged, retry shortly");
  if (!res.ok) throw new Error(`CoinGecko responded ${res.status} — not charged`);
  const all = (await res.json()) as Deriv[];
  if (!Array.isArray(all)) throw new Error("Derivatives data returned an unexpected shape — not charged");

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // Group perpetuals by coin, OI-weight funding + basis.
  const byCoin = new Map<string, { oi: number; fundW: number; fundOi: number; basisW: number; basisOi: number; venues: number }>();
  for (const d of all) {
    if ((d.contract_type ?? "").toLowerCase() !== "perpetual") continue;
    const coin = (d.index_id ?? "").toUpperCase();
    if (!coin) continue;
    const g = byCoin.get(coin) ?? { oi: 0, fundW: 0, fundOi: 0, basisW: 0, basisOi: 0, venues: 0 };
    const oi = num(d.open_interest) ?? 0;
    g.oi += oi; g.venues += 1;
    const f = num(d.funding_rate);
    if (f !== null) { g.fundW += f * (oi || 1); g.fundOi += oi || 1; }
    const b = num(d.basis);
    if (b !== null) { g.basisW += b * (oi || 1); g.basisOi += oi || 1; }
    byCoin.set(coin, g);
  }

  const coins = [...byCoin.entries()]
    .filter(([, g]) => g.oi >= minOiUsd && g.fundOi > 0)
    .map(([coin, g]) => {
      const fundingPct = g.fundW / g.fundOi;
      return {
        coin,
        annualizedFundingPct: +(fundingPct * 3 * 365).toFixed(1),
        fundingPctPerInterval: +fundingPct.toFixed(4),
        basisPct: g.basisOi > 0 ? +(g.basisW / g.basisOi).toFixed(3) : null,
        openInterestUsd: Math.round(g.oi),
        venues: g.venues,
      };
    });

  if (coins.length === 0) {
    return { minOiUsd, coinsScanned: byCoin.size, verdict: "no_data", note: `No perps cleared the $${minOiUsd.toLocaleString("en-US")} OI floor — lower minOi or retry. Not financial advice.`, checkedAt: new Date().toISOString() };
  }

  const crowdedLongs = [...coins].sort((a, b) => b.annualizedFundingPct - a.annualizedFundingPct).slice(0, topN);
  const crowdedShorts = [...coins].sort((a, b) => a.annualizedFundingPct - b.annualizedFundingPct).slice(0, topN);
  // Market-wide tilt: OI-weighted funding across all liquid coins.
  const totOi = coins.reduce((s, c) => s + c.openInterestUsd, 0);
  const mktFunding = +(coins.reduce((s, c) => s + c.fundingPctPerInterval * c.openInterestUsd, 0) / (totOi || 1) * 3 * 365).toFixed(1);
  const tilt = mktFunding > 5 ? "net_long_crowded" : mktFunding < -5 ? "net_short_crowded" : "balanced";

  return {
    minOiUsd,
    coinsScanned: byCoin.size,
    coinsOverFloor: coins.length,
    marketAnnualizedFundingPct: mktFunding,
    marketTilt: tilt, // net_long_crowded | net_short_crowded | balanced
    crowdedLongs, // highest positive funding — longs paying, long-squeeze risk on a dip
    crowdedShorts, // most negative funding — shorts paying, short-squeeze fuel on a pump
    verdict: tilt,
    recommendation:
      `Across ${coins.length} coins over $${(minOiUsd / 1e6).toFixed(0)}M OI, the perp market is ${tilt.replace(/_/g, " ")} (~${mktFunding}%/yr OI-weighted funding). ` +
      (crowdedLongs[0] && crowdedLongs[0].annualizedFundingPct > 25
        ? `Most crowded long: ${crowdedLongs[0].coin} (~${crowdedLongs[0].annualizedFundingPct}%/yr) — long-squeeze risk on a dip. `
        : "") +
      (crowdedShorts[0] && crowdedShorts[0].annualizedFundingPct < -25
        ? `Most crowded short: ${crowdedShorts[0].coin} (~${crowdedShorts[0].annualizedFundingPct}%/yr) — short-squeeze fuel on a pump. `
        : "") +
      "The funding edges are where reflexive moves start — a setup radar, not an entry signal.",
    note: "Scans the whole perp market (CoinGecko, no key), groups by coin, OI-weights funding, and ranks the most crowded longs/shorts over an OI floor. Funding annualised assuming 8h intervals (estimate; venues differ). A market-structure / squeeze-setup signal, not a price call. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
