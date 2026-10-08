/**
 * price-impact — the question an agent must answer before it buys: how much will
 * MY trade move the price? A quote tells you today's price; it does not tell you
 * that a $5k buy into a $20k pool pays 20% more than the screen says. This does.
 *
 * Method: take the deepest Base pool for the token (DexScreener liquidity, the
 * reliable no-key read), treat it as constant-product (Uniswap-V2 / Aerodrome
 * volatile — what most Base pairs are) and compute the exact x*y=k impact for the
 * requested USD size. For a 50/50 pool the quote-side reserve is ~half the USD
 * liquidity, so the executed-vs-spot loss is size/(reserve+size).
 *
 * It is deliberately CONSERVATIVE: concentrated-liquidity (V3 / Aerodrome CL)
 * pools usually fill the same size with LESS impact, so a real swap tends to beat
 * this number — the right direction for a safety/sizing tool. It also returns the
 * largest size that stays under 1% and 3% impact, which is what sizing actually
 * needs. Confirm the exact fill with a live quote (swap-route / base-swap) before
 * trading. Not a price feed, not financial advice.
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

/** Constant-product executed-vs-spot loss for buying `size` USD against a `reserve` USD side. */
function cpImpact(size: number, reserve: number): number {
  return size / (reserve + size); // fraction, 0..1
}
/** Inverse: the largest USD size that keeps impact ≤ target against `reserve`. */
function maxSizeForImpact(target: number, reserve: number): number {
  return (reserve * target) / (1 - target);
}

export async function priceImpact(params: Record<string, string>) {
  const address = (params.address || params.token || "").trim();
  if (!validAddr(address)) throw new Error("Provide a valid 0x… token address");
  const sizeUsd = Number(params.size ?? params.sizeUsd ?? params.amount ?? params.usd);
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) throw new Error("Provide the trade size in USD (size=5000)");
  const side = (params.side || "buy").toLowerCase() === "sell" ? "sell" : "buy";

  const raw = await dexTokenPairs<Pair>(address);
  if (raw === null) throw new Error("Pools fetch failed (DexScreener unavailable) — not charged, retry shortly");
  const addrLc = address.toLowerCase();

  // Deepest pool where this token is the base asset (so priceUsd and liquidity are about it).
  const pools = (raw || [])
    .filter((p) => p?.baseToken?.address?.toLowerCase() === addrLc && (p.liquidity?.usd ?? 0) > 0)
    .map((p) => ({
      dex: p.dexId ?? null,
      pair: p.pairAddress ?? null,
      quote: p.quoteToken?.symbol ?? null,
      priceUsd: Number(p.priceUsd) || null,
      liquidityUsd: p.liquidity?.usd ?? 0,
      volume24h: p.volume?.h24 ?? 0,
    }))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);

  if (pools.length === 0) throw new Error("No liquid pool found for this token on Base — it may not be trading yet");

  const deepest = pools[0];
  const liquidityUsd = deepest.liquidityUsd;
  // Quote-side reserve of a 50/50 constant-product pool ≈ half the reported USD liquidity.
  const reserve = liquidityUsd / 2;

  const impact = cpImpact(sizeUsd, reserve); // 0..1
  const impactPct = +(impact * 100).toFixed(2);
  const maxUnder1 = Math.floor(maxSizeForImpact(0.01, reserve));
  const maxUnder3 = Math.floor(maxSizeForImpact(0.03, reserve));
  const sizeVsLiquidityPct = +((sizeUsd / liquidityUsd) * 100).toFixed(1);

  const verdict =
    impactPct < 1 ? "negligible" : impactPct < 3 ? "moderate" : impactPct < 10 ? "high" : "severe";

  return {
    address,
    side, // informational; constant-product impact is near-symmetric at a given size
    sizeUsd,
    pool: { dex: deepest.dex, pair: deepest.pair, quote: deepest.quote, priceUsd: deepest.priceUsd, liquidityUsd, volume24h: deepest.volume24h },
    otherPools: pools.length - 1,
    estImpactPct: impactPct, // executed vs spot, conservative (constant-product)
    sizeVsLiquidityPct,
    maxSizeUnder1pctUsd: maxUnder1,
    maxSizeUnder3pctUsd: maxUnder3,
    verdict, // negligible | moderate | high | severe
    recommendation:
      verdict === "negligible"
        ? `A $${sizeUsd.toLocaleString("en-US")} ${side} moves the price ~${impactPct}% against the deepest pool ($${Math.round(liquidityUsd).toLocaleString("en-US")} on ${deepest.dex}) — negligible. You can go bigger: ~$${maxUnder1.toLocaleString("en-US")} stays under 1%.`
        : verdict === "moderate"
          ? `~${impactPct}% impact for $${sizeUsd.toLocaleString("en-US")} on the deepest pool ($${Math.round(liquidityUsd).toLocaleString("en-US")}, ${deepest.dex}). Acceptable but not free — to stay under 1% keep it to ~$${maxUnder1.toLocaleString("en-US")}, split the order, or use an aggregator.`
          : verdict === "high"
            ? `⚠️ ~${impactPct}% impact — this trade is large versus the pool (${sizeVsLiquidityPct}% of its liquidity). Split it (≤~$${maxUnder3.toLocaleString("en-US")} per clip for <3%) or route across venues; a single fill will cost you.`
            : `🛑 ~${impactPct}% impact — your size (${sizeVsLiquidityPct}% of pool liquidity) overwhelms the only real pool. Expect a terrible fill and heavy sandwich exposure; do NOT market-buy this size. Reduce to ~$${maxUnder3.toLocaleString("en-US")} or skip.`,
    note: "Conservative price-impact estimate: deepest DexScreener pool treated as constant-product (Uniswap-V2 / Aerodrome volatile). Concentrated-liquidity pools usually do better, so a live swap tends to beat this. An estimate, not a quote — confirm the exact fill with swap-route / base-swap before trading. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
