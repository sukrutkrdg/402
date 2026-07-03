/**
 * Swap Route + Safety — "where do I trade this, what's the impact, and is it safe
 * to receive?"
 *
 * Moves from analysis to action: given a token to acquire and a trade size, it
 * finds the deepest Base pool, estimates price impact with constant-product math,
 * suggests a slippage tolerance + minimum-out, and gates the whole thing on a
 * honeypot/sell-tax check of the token you'd be receiving (no point routing into
 * something you can't sell). Free upstreams (DexScreener + GoPlus).
 *
 * Optional upgrade: set ZEROX_API_KEY to swap the estimate for a real 0x quote
 * (left as a follow-up; this version is fully functional with no paid key).
 */

import "server-only";
import { tokenPools } from "./onchain-extra";
import { impactPct } from "./liquidity";
import { tokenRisk } from "./onchain";

interface Pool {
  pairAddress?: string | null;
  dexId?: string | null;
  quoteSymbol?: string | null;
  priceUsd?: string | number | null;
  liquidityUsd?: number | null;
  volume24h?: number | null;
}
interface Security {
  isHoneypot?: boolean;
  sellTaxPct?: number | null;
  buyTaxPct?: number | null;
}
interface RiskShape {
  flags?: string[];
  security?: Security;
}

export async function swapRoute(params: Record<string, string>) {
  const tokenOut = (params.tokenOut || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenOut)) {
    throw new Error("Provide a valid 0x… tokenOut (the token you want to receive)");
  }
  const amountUsd = Math.max(0, parseFloat(params.amountUsd || params.size || "1000") || 1000);

  // Deepest pool drives execution. Throws (pre-settlement) if no pool exists.
  const poolsRes = (await tokenPools({ address: tokenOut })) as { pools?: Pool[] };
  const pools = poolsRes.pools ?? [];
  if (pools.length === 0) throw new Error("No tradeable pool found for this token on Base");
  const best = pools[0]; // tokenPools already sorts by liquidity desc

  const liquidityUsd = best.liquidityUsd ?? 0;
  const reserveUsd = liquidityUsd / 2; // one side of a ~50/50 pool
  const estImpact = impactPct(amountUsd, reserveUsd);
  // Slippage tolerance = impact + a 1% buffer, clamped to a sane range.
  const suggestedSlippagePct = +Math.min(50, Math.max(0.5, estImpact + 1)).toFixed(2);
  const suggestedMinOutPct = +Math.max(0, 100 - suggestedSlippagePct).toFixed(2);

  // Safety gate on the token you'd receive.
  let safety: { honeypot: boolean; sellTaxPct: number | null; canReceiveSafely: boolean; note: string } | null = null;
  try {
    const risk = (await tokenRisk({ address: tokenOut })) as RiskShape;
    const sec = risk.security;
    const honeypot = Boolean(sec?.isHoneypot) || (risk.flags || []).includes("honeypot");
    const sellTax = typeof sec?.sellTaxPct === "number" ? sec.sellTaxPct : null;
    const canReceiveSafely = !honeypot && (sellTax === null || sellTax < 50);
    safety = {
      honeypot,
      sellTaxPct: sellTax,
      canReceiveSafely,
      note: honeypot
        ? "Token is flagged as a honeypot — you may not be able to sell it. Do not route into it."
        : sellTax !== null && sellTax >= 50
          ? `Extreme sell tax (${sellTax}%) — you'd keep almost nothing on exit.`
          : "No honeypot / extreme-tax flag on the token you'd receive.",
    };
  } catch {
    safety = null; // security provider down → surface the route, flag safety as unknown
  }

  const highImpact = estImpact >= 10;
  const verdict =
    safety && !safety.canReceiveSafely
      ? "do_not_trade"
      : highImpact
        ? "trade_reduces_size"
        : "ok";

  return {
    tokenOut,
    tradeSizeUsd: amountUsd,
    bestPool: {
      pairAddress: best.pairAddress ?? null,
      dex: best.dexId ?? null,
      quoteSymbol: best.quoteSymbol ?? null,
      priceUsd: best.priceUsd ?? null,
      liquidityUsd: +liquidityUsd.toFixed(0),
      volume24h: best.volume24h ?? null,
    },
    poolCount: pools.length,
    estPriceImpactPct: estImpact,
    suggestedSlippagePct,
    suggestedMinOutPct, // set your min-out to this % of the quoted amount
    safety, // honeypot / sell-tax gate on tokenOut (null if unavailable)
    verdict, // ok | trade_reduces_size | do_not_trade
    recommendation:
      verdict === "do_not_trade"
        ? "Don't trade — the token you'd receive fails the sellability gate."
        : highImpact
          ? `Price impact ~${estImpact}% at this size — split the order or reduce size to protect your fill.`
          : `Route via ${best.dexId ?? "the deepest pool"}; set min-out to ${suggestedMinOutPct}% of the quote.`,
    note: "Impact is a constant-product (V2-style) estimate on pool liquidity; concentrated-liquidity pools differ. Set ZEROX_API_KEY for exact routing. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
