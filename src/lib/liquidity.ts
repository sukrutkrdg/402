/**
 * Exit-Liquidity / size-aware slippage — "can I actually get out of this position?"
 *
 * Everyone shows price + liquidity; nobody answers the question that actually
 * matters to a trading agent: if I put $X in, what's my price impact, and can I
 * pull $X back out without collapsing the pool? The hidden form of a rug isn't
 * "you can't buy" — it's "you can't sell". This estimates both from the pool's
 * USD liquidity using constant-product (Uniswap-V2-style) math.
 *
 * Free upstream (DexScreener) → stays in the standard tier.
 */

import "server-only";
import { getAddress } from "viem";

interface DexPair {
  baseToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  dexId?: string;
  url?: string;
}

function reqAddr(raw: string): string {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… token address");
  return getAddress(v);
}

// Price impact of trading `size` USD against a one-sided reserve `reserveUsd`,
// using the constant-product relation impact ≈ size / (reserve + size).
// Exported for unit tests.
export function impactPct(sizeUsd: number, reserveUsd: number): number {
  if (reserveUsd <= 0) return 100;
  return +((100 * sizeUsd) / (reserveUsd + sizeUsd)).toFixed(2);
}

export async function exitLiquidity(params: Record<string, string>) {
  const address = reqAddr(params.address || "");
  const size = Math.max(0, parseFloat(params.size || params.amount || "1000") || 1000);

  let pairs: DexPair[] = [];
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`DexScreener responded ${res.status}`);
    const j = (await res.json()) as { pairs?: DexPair[] | null };
    pairs = (j.pairs ?? []).filter((p) => p.baseToken?.address?.toLowerCase() === address.toLowerCase());
  } catch (err) {
    throw new Error(`Liquidity data unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (pairs.length === 0) throw new Error("No liquidity pool found for this token on Base");

  // Deepest pool drives whether you can actually exit.
  const best = pairs.reduce((top, p) => ((p.liquidity?.usd ?? 0) > (top.liquidity?.usd ?? 0) ? p : top), pairs[0]);
  const liquidityUsd = best.liquidity?.usd ?? 0;
  const price = parseFloat(best.priceUsd ?? "") || null;
  // One side of a ~50/50 pool ≈ half total USD liquidity — the reserve a trade hits.
  const reserveUsd = liquidityUsd / 2;

  const buyImpact = impactPct(size, reserveUsd);
  const sellImpact = impactPct(size, reserveUsd); // symmetric estimate for exit
  // Largest exit that stays under 5% impact: solve s/(r+s)=0.05.
  const maxSafeExitUsd = +((0.05 * reserveUsd) / 0.95).toFixed(0);
  const canExit = sellImpact < 10; // <10% impact to unwind `size` → practically exitable

  const level =
    liquidityUsd < 2000 || sellImpact >= 25
      ? "high"
      : sellImpact >= 10
        ? "medium"
        : "low";

  return {
    address,
    symbol: best.baseToken?.symbol ?? null,
    tradeSizeUsd: size,
    priceUsd: price,
    liquidityUsd: +liquidityUsd.toFixed(0),
    dex: best.dexId ?? null,
    estBuyImpactPct: buyImpact,
    estSellImpactPct: sellImpact,
    canExit, // can you unwind `size` without >10% impact?
    maxSafeExitUsd, // largest exit under ~5% impact
    exitRisk: level, // low | medium | high
    note:
      "Estimate using constant-product (V2-style) math on total pool liquidity; concentrated-liquidity (V3) pools may differ. The point: whether a position of this size can be EXITED, not just entered. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
