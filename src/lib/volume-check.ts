/**
 * Volume Authenticity — "is this trading volume real, or painted on?"
 *
 * Wash trading is how dead tokens get discovered: bots trade a token against
 * itself so it ranks on volume screens, then real buyers become the exit
 * liquidity. This reads the deepest pool's 24h volume, buy/sell counts and
 * liquidity, and scores how organic the activity looks: volume far above
 * liquidity, a near-perfectly-balanced buy/sell count, huge volume with a flat
 * price, or huge volume per transaction are the classic wash signatures.
 * Free upstream (DexScreener).
 */

import "server-only";
import { getAddress } from "viem";
import { dexTokenPairs } from "@/lib/upstream-cache";

interface DexPair {
  baseToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  dexId?: string;
}

export async function volumeCheck(params: Record<string, string>) {
  const raw = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… token contract address");
  const address = getAddress(raw);

  const rawPairs = await dexTokenPairs<DexPair>(address);
  if (rawPairs === null) throw new Error("Market data unavailable: DexScreener unavailable");
  const pairs = rawPairs.filter((p) => p.baseToken?.address?.toLowerCase() === address.toLowerCase());
  if (pairs.length === 0) throw new Error("No trading pair found for this token on Base");

  // Deepest pool carries the volume that matters.
  const best = pairs.reduce((top, p) => ((p.liquidity?.usd ?? 0) > (top.liquidity?.usd ?? 0) ? p : top), pairs[0]);
  const liquidityUsd = best.liquidity?.usd ?? 0;
  const volume24h = best.volume?.h24 ?? 0;
  const buys = best.txns?.h24?.buys ?? 0;
  const sells = best.txns?.h24?.sells ?? 0;
  const txCount = buys + sells;
  const priceChange24h = typeof best.priceChange?.h24 === "number" ? best.priceChange.h24 : null;

  const volumeToLiquidity = liquidityUsd > 0 ? +(volume24h / liquidityUsd).toFixed(2) : null;
  const avgTradeUsd = txCount > 0 ? +(volume24h / txCount).toFixed(0) : null;
  const buySellBalance = txCount > 0 ? +(Math.min(buys, sells) / Math.max(buys, sells, 1)).toFixed(3) : null;

  let suspicion = 0; // 0-100, higher = more likely wash/painted volume
  const signals: string[] = [];
  const add = (n: number, why: string) => {
    suspicion += n;
    signals.push(why);
  };

  // Volume >> liquidity: the whole pool "turning over" 10x+ a day is bot churn.
  if (volumeToLiquidity !== null) {
    if (volumeToLiquidity >= 20) add(35, `24h volume is ${volumeToLiquidity}× the pool's liquidity — extreme churn.`);
    else if (volumeToLiquidity >= 10) add(25, `24h volume is ${volumeToLiquidity}× liquidity — far above organic turnover.`);
    else if (volumeToLiquidity >= 5) add(12, `24h volume is ${volumeToLiquidity}× liquidity — elevated turnover.`);
  }

  // Near-perfect buy/sell symmetry with real activity is a bot signature —
  // organic flow is lopsided.
  if (buySellBalance !== null && txCount >= 50 && buySellBalance >= 0.95) {
    add(25, `Buys and sells are almost perfectly balanced (${buys}/${sells}) — round-trip bot pattern.`);
  }

  // Big volume that moves the price nowhere: trades against yourself are price-neutral.
  if (priceChange24h !== null && volume24h >= 50000 && Math.abs(priceChange24h) < 1) {
    add(20, `$${Math.round(volume24h).toLocaleString()} of volume moved the price ${priceChange24h}% — volume without price discovery.`);
  }

  // Very large average trade size in a small pool = a few wallets recycling size.
  if (avgTradeUsd !== null && liquidityUsd > 0 && avgTradeUsd >= liquidityUsd * 0.05 && txCount >= 20) {
    add(15, `Average trade is $${avgTradeUsd.toLocaleString()} (~${((avgTradeUsd / liquidityUsd) * 100).toFixed(1)}% of the pool) — a few wallets recycling size.`);
  }

  suspicion = Math.min(100, Math.round(suspicion));
  const verdict = suspicion >= 60 ? "likely_wash" : suspicion >= 30 ? "suspicious" : "looks_organic";

  return {
    address,
    symbol: best.baseToken?.symbol ?? null,
    dex: best.dexId ?? null,
    liquidityUsd: +liquidityUsd.toFixed(0),
    volume24h: +volume24h.toFixed(0),
    txns24h: { buys, sells },
    priceChange24h,
    volumeToLiquidity, // 24h volume ÷ liquidity (organic pools are usually well under 5×)
    avgTradeUsd,
    buySellBalance, // 1.0 = perfectly symmetric (bot-like), organic flow is lopsided
    suspicionScore: suspicion, // 0-100, higher = more likely painted volume
    verdict, // looks_organic | suspicious | likely_wash
    signals,
    recommendation:
      verdict === "likely_wash"
        ? "Treat the volume as fake — the apparent activity is likely bots painting the tape to attract buyers. Do not read it as demand."
        : verdict === "suspicious"
          ? "Volume shows wash-like patterns — discount it and verify demand with holder growth before trading on 'activity'."
          : "Activity pattern is consistent with organic trading.",
    note: "Heuristic read of one pool's volume/liquidity/txn shape. Sophisticated wash trading can evade it; a clean read is not proof of demand. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
