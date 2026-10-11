/**
 * base-dex-spread — Aerodrome vs Uniswap v3 Real-Time Arbitrage & Spread Oracle.
 *
 * Compares live liquidity pool prices and depth between Base's primary DEXes:
 * - Aerodrome (Base native AMM / Slipstream)
 * - Uniswap v3 (Base concentrated liquidity)
 *
 * Calculates:
 * 1. Gross price spread in basis points (bps)
 * 2. Net arbitrage profitability after pool fees (round-trip fee: ~60 bps)
 * 3. Optimal arbitrage direction (BUY_AERODROME_SELL_UNISWAP or reverse)
 * 4. Estimated net profit per $1,000 USD swap
 */

import "server-only";
import { getAddress, type Address } from "viem";
import { dexTokenPairs } from "./upstream-cache";
import { decisionReceipt } from "./envelope";

export interface DexSpreadResult {
  tokenAddress: string;
  hasBothPools: boolean;
  aerodrome: {
    poolAddress: string | null;
    priceUsd: number | null;
    liquidityUsd: number | null;
    quoteToken: string | null;
  } | null;
  uniswap: {
    poolAddress: string | null;
    priceUsd: number | null;
    liquidityUsd: number | null;
    quoteToken: string | null;
  } | null;
  spreadBps: number;
  netArbitrageBps: number;
  direction: "BUY_AERODROME_SELL_UNISWAP" | "BUY_UNISWAP_SELL_AERODROME" | "NO_ARBITRAGE";
  estProfitPer1kUsd: number;
  verdict: "PROFITABLE_SPREAD" | "TIGHT_NO_ARB" | "SINGLE_DEX_ONLY" | "NO_POOLS_FOUND";
  recommendation: string;
}

interface DexPairItem {
  dexId?: string;
  pairAddress?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  quoteToken?: { symbol?: string };
}

export async function baseDexSpread(params: Record<string, string>) {
  const rawAddr = (params.token || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(rawAddr)) {
    throw new Error("Provide a valid 0x… Base token address (token=)");
  }
  const address = getAddress(rawAddr);

  // 1. Fetch live DEX pools for the token
  const pairs = await dexTokenPairs<DexPairItem>(address);
  if (!pairs || pairs.length === 0) {
    const emptyResult: DexSpreadResult = {
      tokenAddress: address.toLowerCase(),
      hasBothPools: false,
      aerodrome: null,
      uniswap: null,
      spreadBps: 0,
      netArbitrageBps: 0,
      direction: "NO_ARBITRAGE",
      estProfitPer1kUsd: 0,
      verdict: "NO_POOLS_FOUND",
      recommendation: "No active liquidity pools found on Base for this token.",
    };

    return {
      tokenAddress: address.toLowerCase(),
      verdict: "NO_POOLS_FOUND",
      spreadBps: 0,
      recommendation: emptyResult.recommendation,
      data: emptyResult,
      receipt: decisionReceipt({
        endpoint: "base-dex-spread",
        params: { token: address.toLowerCase() },
        degraded: false,
      }),
      checkedAt: new Date().toISOString(),
    };
  }

  // Find best Aerodrome and Uniswap pairs (highest liquidity)
  const aeroPairs = pairs.filter((p) => /aero/i.test(p.dexId || ""));
  const uniPairs = pairs.filter((p) => /uni/i.test(p.dexId || ""));

  const bestAero = aeroPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
  const bestUni = uniPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;

  const aeroPrice = bestAero ? parseFloat(bestAero.priceUsd || "0") : null;
  const uniPrice = bestUni ? parseFloat(bestUni.priceUsd || "0") : null;

  const aeroData = bestAero
    ? {
        poolAddress: bestAero.pairAddress || null,
        priceUsd: aeroPrice,
        liquidityUsd: bestAero.liquidity?.usd || null,
        quoteToken: bestAero.quoteToken?.symbol || null,
      }
    : null;

  const uniData = bestUni
    ? {
        poolAddress: bestUni.pairAddress || null,
        priceUsd: uniPrice,
        liquidityUsd: bestUni.liquidity?.usd || null,
        quoteToken: bestUni.quoteToken?.symbol || null,
      }
    : null;

  if (!aeroPrice || !uniPrice || aeroPrice <= 0 || uniPrice <= 0) {
    const singleDex = aeroData ? "Aerodrome" : uniData ? "Uniswap" : "Other DEX";
    const singleResult: DexSpreadResult = {
      tokenAddress: address.toLowerCase(),
      hasBothPools: false,
      aerodrome: aeroData,
      uniswap: uniData,
      spreadBps: 0,
      netArbitrageBps: 0,
      direction: "NO_ARBITRAGE",
      estProfitPer1kUsd: 0,
      verdict: "SINGLE_DEX_ONLY",
      recommendation: `Token has liquidity exclusively on ${singleDex}. Opportunity for market-makers to seed dual-pool liquidity.`,
    };

    return {
      tokenAddress: address.toLowerCase(),
      verdict: "SINGLE_DEX_ONLY",
      spreadBps: 0,
      recommendation: singleResult.recommendation,
      data: singleResult,
      receipt: decisionReceipt({
        endpoint: "base-dex-spread",
        params: { token: address.toLowerCase() },
        degraded: false,
      }),
      checkedAt: new Date().toISOString(),
    };
  }

  // Calculate gross spread
  const minPrice = Math.min(aeroPrice, uniPrice);
  const rawSpread = Math.abs(aeroPrice - uniPrice) / minPrice;
  const spreadBps = Math.round(rawSpread * 10000);

  // Standard round-trip DEX pool fee: ~30 bps on Aerodrome + ~30 bps on Uniswap = 60 bps total
  const ROUNDTRIP_FEE_BPS = 60;
  const netArbitrageBps = Math.max(0, spreadBps - ROUNDTRIP_FEE_BPS);

  let direction: "BUY_AERODROME_SELL_UNISWAP" | "BUY_UNISWAP_SELL_AERODROME" | "NO_ARBITRAGE" = "NO_ARBITRAGE";
  if (spreadBps > ROUNDTRIP_FEE_BPS) {
    direction = aeroPrice < uniPrice ? "BUY_AERODROME_SELL_UNISWAP" : "BUY_UNISWAP_SELL_AERODROME";
  }

  const estProfitPer1kUsd = direction !== "NO_ARBITRAGE" ? Math.round((netArbitrageBps / 10000) * 1000 * 100) / 100 : 0;
  const verdict: "PROFITABLE_SPREAD" | "TIGHT_NO_ARB" = netArbitrageBps > 10 ? "PROFITABLE_SPREAD" : "TIGHT_NO_ARB";

  const recommendation =
    verdict === "PROFITABLE_SPREAD"
      ? `Active ${spreadBps} bps spread (${netArbitrageBps} bps net after fees). Profitable arb: ${direction} (~$${estProfitPer1kUsd.toFixed(2)}/1k USD).`
      : `Spread is tight (${spreadBps} bps). Below round-trip fee threshold (60 bps). No profitable arbitrage.`;

  const result: DexSpreadResult = {
    tokenAddress: address.toLowerCase(),
    hasBothPools: true,
    aerodrome: aeroData,
    uniswap: uniData,
    spreadBps,
    netArbitrageBps,
    direction,
    estProfitPer1kUsd,
    verdict,
    recommendation,
  };

  return {
    tokenAddress: address.toLowerCase(),
    verdict,
    spreadBps,
    direction,
    estProfitPer1kUsd,
    recommendation,
    data: result,
    receipt: decisionReceipt({
      endpoint: "base-dex-spread",
      params: { token: address.toLowerCase() },
      degraded: false,
    }),
    checkedAt: new Date().toISOString(),
  };
}

export const dexSpread = baseDexSpread;
