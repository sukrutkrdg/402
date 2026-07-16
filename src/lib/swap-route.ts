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
import { securityChecked as wasSecurityChecked, type TokenRiskResult } from "./envelope";
import { CdpClient } from "@coinbase/cdp-sdk";
import { getConfig } from "./config";

interface Pool {
  pairAddress?: string | null;
  dexId?: string | null;
  quoteSymbol?: string | null;
  priceUsd?: string | number | null;
  liquidityUsd?: number | null;
  volume24h?: number | null;
}
type RiskShape = TokenRiskResult;

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * Real 0x quote (Base) when ZEROX_API_KEY is set — exact routing + price impact
 * for buying `tokenOut` with `amountUsd` of USDC. Returns null (→ fall back to
 * the constant-product estimate) when unset or on any error, so the service
 * always works without a key.
 */
async function zeroxQuote(
  tokenOut: string,
  amountUsd: number,
): Promise<{ impactPct: number | null; buyAmount: string | null; sources: string[] } | null> {
  const key = process.env.ZEROX_API_KEY?.trim();
  if (!key) return null;
  try {
    const sellAmount = Math.round(amountUsd * 1e6).toString(); // USDC has 6 decimals
    const url = `https://api.0x.org/swap/permit2/quote?chainId=8453&sellToken=${USDC_BASE}&buyToken=${tokenOut}&sellAmount=${sellAmount}`;
    const res = await fetch(url, {
      headers: { "0x-api-key": key, "0x-version": "v2" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      buyAmount?: string;
      estimatedPriceImpact?: string;
      route?: { fills?: Array<{ source?: string }> };
    };
    const impact = j.estimatedPriceImpact != null ? +parseFloat(j.estimatedPriceImpact).toFixed(2) : null;
    const sources = [...new Set((j.route?.fills ?? []).map((f) => f.source ?? "").filter(Boolean))];
    return { impactPct: impact, buyAmount: j.buyAmount ?? null, sources };
  } catch {
    return null;
  }
}

// Quote routing is taker-independent; a default holder is used unless the caller
// passes `taker` (then balance/allowance issues reflect that wallet).
const DEFAULT_TAKER = "0x973a31858f4d2125f48c880542da11a2796f12d6";

/**
 * Real CDP Trade API quote (Base) when CDP keys are set — actual routed output
 * (toAmount / minToAmount), gas, and simulation issues for buying `tokenOut`
 * with `amountUsd` of USDC. Returns null on missing keys or error so the service
 * always works without CDP.
 */
async function cdpQuote(
  tokenOut: string,
  amountUsd: number,
  taker?: string,
): Promise<{ liquidityAvailable: boolean; toAmount?: string; minToAmount?: string; gas?: string | null; simulationIncomplete?: boolean } | null> {
  const cfg = getConfig();
  if (!cfg.cdpApiKeyId || !cfg.cdpApiKeySecret) return null;
  try {
    const cdp = new CdpClient({ apiKeyId: cfg.cdpApiKeyId, apiKeySecret: cfg.cdpApiKeySecret });
    const fromAmount = BigInt(Math.round(amountUsd * 1e6)); // USDC has 6 decimals
    const takerAddr = (/^0x[0-9a-fA-F]{40}$/.test(taker ?? "") ? taker! : DEFAULT_TAKER) as `0x${string}`;
    const p = await cdp.evm.getSwapPrice({
      network: "base",
      fromToken: USDC_BASE as `0x${string}`,
      toToken: tokenOut as `0x${string}`,
      fromAmount,
      taker: takerAddr,
      slippageBps: 100,
    });
    if (!p.liquidityAvailable) return { liquidityAvailable: false };
    return {
      liquidityAvailable: true,
      toAmount: p.toAmount.toString(),
      minToAmount: p.minToAmount.toString(),
      gas: p.gas != null ? p.gas.toString() : null,
      simulationIncomplete: p.issues?.simulationIncomplete ?? false,
    };
  } catch {
    return null;
  }
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
  const cpImpact = impactPct(amountUsd, reserveUsd); // constant-product estimate
  // Prefer a real 0x quote's impact when ZEROX_API_KEY is set; else the estimate.
  const zerox = await zeroxQuote(tokenOut, amountUsd);
  const cdp = await cdpQuote(tokenOut, amountUsd, params.taker);
  const estImpact = zerox?.impactPct ?? cpImpact;
  // Slippage tolerance = impact + a 1% buffer, clamped to a sane range.
  const suggestedSlippagePct = +Math.min(50, Math.max(0.5, estImpact + 1)).toFixed(2);
  const suggestedMinOutPct = +Math.max(0, 100 - suggestedSlippagePct).toFixed(2);

  // Safety gate on the token you'd receive.
  let safety: { honeypot: boolean; sellTaxPct: number | null; canReceiveSafely: boolean; note: string } | null = null;
  try {
    const risk = (await tokenRisk({ address: tokenOut })) as RiskShape;
    if (!wasSecurityChecked(risk)) {
      // GoPlus wasn't consulted — tokenRisk still fulfilled, but honeypot/tax are
      // UNKNOWN, not clean. Leave safety null (the "unknown" path) rather than
      // asserting "no honeypot flag".
      safety = null;
    } else {
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
    }
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
    impactSource: zerox?.impactPct != null ? "0x" : "estimate",
    zeroxRoute: zerox ? { buyAmount: zerox.buyAmount, sources: zerox.sources } : null,
    cdpRoute:
      cdp && cdp.liquidityAvailable
        ? { toAmount: cdp.toAmount, minToAmount: cdp.minToAmount, gasEstimate: cdp.gas, simulationIncomplete: cdp.simulationIncomplete }
        : cdp
          ? { liquidityAvailable: false }
          : null,
    suggestedSlippagePct,
    suggestedMinOutPct, // set your min-out to this % of the quoted amount
    safety, // honeypot / sell-tax gate on tokenOut (null if unavailable)
    safetyChecked: safety !== null, // false → could not screen the destination token
    verdict, // ok | trade_reduces_size | do_not_trade
    recommendation:
      verdict === "do_not_trade"
        ? "Don't trade — the token you'd receive fails the sellability gate."
        : highImpact
          ? `Price impact ~${estImpact}% at this size — split the order or reduce size to protect your fill.`
          : safety === null
            ? `Route looks fine on depth, but the destination token could NOT be safety-screened this call (honeypot/tax unknown) — re-check with token-risk before routing. Set min-out to ${suggestedMinOutPct}%.`
            : `Route via ${best.dexId ?? "the deepest pool"}; set min-out to ${suggestedMinOutPct}% of the quote.`,
    note: "cdpRoute gives exact routed output (toAmount/minToAmount, atomic units) via the CDP Trade API when CDP keys are set; price impact is a constant-product estimate (or 0x when ZEROX_API_KEY is set). Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
