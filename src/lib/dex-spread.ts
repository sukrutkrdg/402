/**
 * DEX price spread — is this token priced differently across venues, and why?
 *
 * A token that trades on several Base DEXes should cost about the same on each;
 * a gap is either an arbitrage window a trading agent can take, or — when it sits
 * on a thin or stale pool — a mispricing that signals wash/manipulation and a
 * price no one should trust. token-pools lists the pools; this does the thing an
 * agent actually needs: compare the price across the LIQUID venues and say which
 * it is.
 *
 * It only compares pools where the queried token is the base asset (so priceUsd
 * is really this token's price) and that clear a liquidity floor, because a $200
 * pool "pricing" the token 40% off is noise, not an opportunity. The verdict
 * separates a real arb window from the thin-pool mispricing that looks identical
 * on a naive scan.
 */

import "server-only";
import { dexTokenPairs } from "./upstream-cache";

interface Pair {
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
}

const OUTLIER_DEVIATION = 0.03;

/** Liquidity-weighted median price; null for an empty set. */
export function weightedMedian(ps: ReadonlyArray<{ priceUsd: number; liquidityUsd: number }>): number | null {
  if (!ps.length) return null;
  const sorted = [...ps].sort((a, b) => a.priceUsd - b.priceUsd);
  const total = sorted.reduce((t, p) => t + Math.max(p.liquidityUsd, 0), 0);
  if (total <= 0) return sorted[Math.floor(sorted.length / 2)].priceUsd;
  let acc = 0;
  for (const p of sorted) {
    acc += Math.max(p.liquidityUsd, 0);
    if (acc >= total / 2) return p.priceUsd;
  }
  return sorted[sorted.length - 1].priceUsd;
}

const validAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test((a ?? "").trim());

export async function dexSpread(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… token address");
  const minLiquidityUsd = Math.max(0, Number(params.minLiquidityUsd ?? params.minLiquidity ?? 5000) || 5000);

  const raw = await dexTokenPairs<Pair>(address);
  if (raw === null) throw new Error("Pools fetch failed (DexScreener unavailable) — not charged, retry shortly");
  const addrLc = address.toLowerCase();

  // Only base-token pools with a real price, then split by the liquidity floor.
  const priced = (raw || [])
    .filter((p) => p?.baseToken?.address?.toLowerCase() === addrLc && p.priceUsd && Number(p.priceUsd) > 0)
    .map((p) => ({
      dex: p.dexId ?? null,
      pair: p.pairAddress ?? null,
      quote: p.quoteToken?.symbol ?? null,
      priceUsd: Number(p.priceUsd),
      liquidityUsd: p.liquidity?.usd ?? 0,
      volume24h: p.volume?.h24 ?? 0,
    }))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);

  if (priced.length === 0) throw new Error("No priced pool found for this token on Base — it may not be trading yet");

  const liquid = priced.filter((p) => p.liquidityUsd >= minLiquidityUsd);
  const venues = (liquid.length >= 1 ? liquid : priced).slice(0, 10);

  // A pool that clears the floor can still be thin next to the token's real
  // market, and DexScreener's USD price on such a pool is often stale. AERO read
  // a 31% "wide" spread because a $6.5k Uniswap pool sat at $0.687 while the $45M
  // Aerodrome pool and every deep venue agreed within 1%. So: take the
  // liquidity-weighted median price, and set aside a venue that is both far from
  // it (>3%) and thin relative to the market: under the larger of 1% of the
  // deepest pool and 10× the floor, and under 10% of the deepest. It is reported
  // in thinOutliers, never hidden. Deep or comparable venues that disagree stay
  // in the basis, so a real gap still reads wide.
  const ref = weightedMedian(liquid);
  const deepest = liquid.length ? liquid[0].liquidityUsd : 0;
  const thinCap = Math.max(minLiquidityUsd * 10, deepest * 0.01);
  const isOutlier = (p: { priceUsd: number; liquidityUsd: number }) =>
    ref !== null &&
    Math.abs(p.priceUsd / ref - 1) > OUTLIER_DEVIATION &&
    p.liquidityUsd < thinCap &&
    p.liquidityUsd < deepest * 0.1; // two comparable pools that disagree are a real gap, not an outlier
  const thinOutliers = liquid.filter(isOutlier).map((p) => ({
    dex: p.dex,
    pair: p.pair,
    priceUsd: p.priceUsd,
    liquidityUsd: p.liquidityUsd,
    deviationPct: +(((p.priceUsd - (ref as number)) / (ref as number)) * 100).toFixed(2),
  }));
  const core = liquid.filter((p) => !isOutlier(p));

  // Spread is computed over the liquid, non-outlier set only; a single venue
  // means there is no cross-DEX price to compare, and the price rests on that one pool.
  const basis = core.length >= 2 ? core : [];
  const prices = basis.map((p) => p.priceUsd);
  const min = prices.length ? Math.min(...prices) : null;
  const max = prices.length ? Math.max(...prices) : null;
  const spreadPct = min && max ? +(((max - min) / min) * 100).toFixed(3) : null;

  const cheapest = basis.length ? basis.reduce((a, b) => (b.priceUsd < a.priceUsd ? b : a)) : null;
  const dearest = basis.length ? basis.reduce((a, b) => (b.priceUsd > a.priceUsd ? b : a)) : null;

  let verdict: "tight" | "arb_window" | "wide" | "single_venue";
  if (basis.length < 2) verdict = "single_venue";
  else if ((spreadPct as number) < 0.5) verdict = "tight";
  else if ((spreadPct as number) <= 3) verdict = "arb_window";
  else verdict = "wide";

  // A wide spread where one side is a thin pool is a mispricing, not free money.
  const thinnestInBasis = basis.length ? Math.min(...basis.map((p) => p.liquidityUsd)) : null;
  const thinSide = thinnestInBasis !== null && thinnestInBasis < minLiquidityUsd * 2;

  return {
    address,
    liquidVenues: liquid.length,
    totalVenues: priced.length,
    referencePriceUsd: ref, // liquidity-weighted median over liquid venues
    comparedVenues: basis.length,
    minLiquidityUsd,
    spreadPct, // null when fewer than 2 liquid venues
    cheapest: cheapest ? { dex: cheapest.dex, priceUsd: cheapest.priceUsd, liquidityUsd: cheapest.liquidityUsd } : null,
    dearest: dearest ? { dex: dearest.dex, priceUsd: dearest.priceUsd, liquidityUsd: dearest.liquidityUsd } : null,
    venues,
    thinOutliers, // liquid-but-thin venues far from the reference price, left out of spreadPct
    verdict, // tight | arb_window | wide | single_venue
    recommendation:
      verdict === "single_venue"
        ? `Only one venue clears $${minLiquidityUsd.toLocaleString("en-US")} liquidity${thinOutliers.length ? ` without being a thin outlier` : ""}, so there is no cross-DEX price to check — the quote rests entirely on that pool and is as manipulable as that pool is thin.`
        : verdict === "tight"
          ? `Prices agree across ${liquid.length} liquid venues (${spreadPct}% spread) — an efficient, trustworthy price.`
          : verdict === "arb_window"
            ? `A ${spreadPct}% gap between ${cheapest?.dex} (cheap) and ${dearest?.dex} (dear)${thinSide ? " — but one side is thin, so check depth before assuming it is arbitrageable size" : " — a real arbitrage window at modest size"}.`
            : `Wide ${spreadPct}% gap across venues. ${thinSide ? "One side is a thin pool, so this is most likely a MISPRICING / wash signal, not free money — do not trust the off-pool price." : "Large and both sides liquid — unusual; confirm with a live quote before acting."}`,
    outlierNote: thinOutliers.length
      ? `${thinOutliers.length} thin pool(s) priced more than 3% away from the market were left out of the spread (see thinOutliers) — a stale or mispriced pool, not an arbitrage you can size into.`
      : null,
    note: "Compares a token's price across the Base DEXes it trades on, over a liquidity floor (default $5k), and separates a real arbitrage window from thin-pool mispricing. A thin pool far from the liquidity-weighted median is listed in thinOutliers instead of setting the spread. Prices are DexScreener snapshots — confirm with a live swap quote before trading. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
