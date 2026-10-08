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

  // Spread is computed over the LIQUID set only; a single liquid venue means there
  // is no cross-DEX price to compare, and the price rests on that one pool.
  const basis = liquid.length >= 2 ? liquid : [];
  const prices = basis.map((p) => p.priceUsd);
  const min = prices.length ? Math.min(...prices) : null;
  const max = prices.length ? Math.max(...prices) : null;
  const spreadPct = min && max ? +(((max - min) / min) * 100).toFixed(3) : null;

  const cheapest = basis.length ? basis.reduce((a, b) => (b.priceUsd < a.priceUsd ? b : a)) : null;
  const dearest = basis.length ? basis.reduce((a, b) => (b.priceUsd > a.priceUsd ? b : a)) : null;

  let verdict: "tight" | "arb_window" | "wide" | "single_venue";
  if (liquid.length < 2) verdict = "single_venue";
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
    minLiquidityUsd,
    spreadPct, // null when fewer than 2 liquid venues
    cheapest: cheapest ? { dex: cheapest.dex, priceUsd: cheapest.priceUsd, liquidityUsd: cheapest.liquidityUsd } : null,
    dearest: dearest ? { dex: dearest.dex, priceUsd: dearest.priceUsd, liquidityUsd: dearest.liquidityUsd } : null,
    venues,
    verdict, // tight | arb_window | wide | single_venue
    recommendation:
      verdict === "single_venue"
        ? `Only one venue clears $${minLiquidityUsd.toLocaleString("en-US")} liquidity, so there is no cross-DEX price to check — the quote rests entirely on that pool and is as manipulable as that pool is thin.`
        : verdict === "tight"
          ? `Prices agree across ${liquid.length} liquid venues (${spreadPct}% spread) — an efficient, trustworthy price.`
          : verdict === "arb_window"
            ? `A ${spreadPct}% gap between ${cheapest?.dex} (cheap) and ${dearest?.dex} (dear)${thinSide ? " — but one side is thin, so check depth before assuming it is arbitrageable size" : " — a real arbitrage window at modest size"}.`
            : `Wide ${spreadPct}% gap across venues. ${thinSide ? "One side is a thin pool, so this is most likely a MISPRICING / wash signal, not free money — do not trust the off-pool price." : "Large and both sides liquid — unusual; confirm with a live quote before acting."}`,
    note: "Compares a token's price across the Base DEXes it trades on, over a liquidity floor (default $5k), and separates a real arbitrage window from thin-pool mispricing. Prices are DexScreener snapshots — confirm with a live swap quote before trading. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
