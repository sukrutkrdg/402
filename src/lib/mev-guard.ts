/**
 * MEV guard — how exposed is THIS swap to a sandwich, and how to land it safely.
 *
 * Agents are the easiest MEV prey on chain: their execution is predictable, they
 * trade public-mempool by default, and agent-adjacent pools show a measured 40%+
 * jump in extraction — a conservative ~$50M/quarter tax. A sandwich is only
 * profitable when a trade moves the pool price enough to front-run; that is a
 * function of trade size against pool depth, which we already compute for
 * swap-route. This turns those same numbers into an exposure read and a concrete
 * protected-execution plan rather than leaving the agent to send blind.
 *
 * Exposure rises with (a) price impact — the room a sandwich has to work in — and
 * (b) trade size relative to pool liquidity. The plan it recommends is the one
 * that actually removes the edge: a tight min-out (caps what a sandwich can
 * take), private/off-mempool inclusion, and for a large trade, splitting it into
 * chunks too small to be worth attacking. On Base, a Cobalt validity transaction
 * keeps the order private until it lands — so base-swap-validity / validity-build
 * is the native private path, named here.
 *
 * It composes swap-route (no re-implementation) and never asserts safety it did
 * not read: if the impact source is an estimate rather than a live 0x quote, the
 * response says so.
 */

import "server-only";
import { swapRoute } from "./swap-route";

type Exposure = "low" | "elevated" | "high";

/**
 * Pure classifier, testable without a chain. Sandwich exposure from price impact
 * and trade-size-to-liquidity ratio. Thresholds are deliberately conservative:
 * impact is the dominant term (it is the attacker's working room), depth ratio
 * sharpens it.
 */
export function sandwichExposure(impactPct: number, tradeSizeUsd: number, liquidityUsd: number): Exposure {
  const depthRatio = liquidityUsd > 0 ? tradeSizeUsd / liquidityUsd : Infinity;
  if (impactPct >= 2 || depthRatio >= 0.05) return "high";
  if (impactPct >= 0.5 || depthRatio >= 0.01) return "elevated";
  return "low";
}

export async function mevGuard(params: Record<string, string>) {
  // swap-route does the pool/impact/safety reads for the token being bought.
  const route = (await swapRoute(params)) as {
    tokenOut: string;
    tradeSizeUsd: number;
    bestPool?: { liquidityUsd?: number; dex?: string | null };
    estPriceImpactPct?: number;
    impactSource?: string;
    suggestedSlippagePct?: number;
    suggestedMinOutPct?: number;
    poolCount?: number;
    safety?: { canReceiveSafely?: boolean; note?: string } | null;
  };

  const impact = route.estPriceImpactPct ?? 0;
  const liquidityUsd = route.bestPool?.liquidityUsd ?? 0;
  const size = route.tradeSizeUsd;
  const exposure = sandwichExposure(impact, size, liquidityUsd);

  // The protected-execution plan, strongest step first. Each item is an action an
  // agent can take now; the private path on Base is our own validity transaction.
  const plan: string[] = [];
  plan.push(`Set a hard minimum-out: cap slippage at ~${route.suggestedSlippagePct ?? 1}% (minOut ≈ ${route.suggestedMinOutPct ?? 99}% of quote). A sandwich can only take what your slippage allows — a tight bound is the single highest-leverage defence.`);
  if (exposure !== "low") {
    plan.push("Submit privately, off the public mempool, so a searcher cannot see and reorder around the trade. On Base this is a Cobalt validity transaction — build one with validity-build (any signed tx) or base-swap-validity (a swap), which keeps the order private until it lands.");
  }
  if (exposure === "high") {
    plan.push("Split the order into chunks each too small to be worth attacking (keep per-chunk impact under ~0.5%), and/or trade into the deepest pool only — shallow pools are where the impact, and the sandwich, is largest.");
  }

  const safetyUnknown = route.safety == null;

  return {
    tokenOut: route.tokenOut,
    tradeSizeUsd: size,
    exposure, // low | elevated | high
    estPriceImpactPct: impact,
    impactSource: route.impactSource ?? "estimate", // "0x" (live quote) or "estimate"
    liquidityUsd,
    poolCount: route.poolCount ?? null,
    sizeToLiquidityPct: liquidityUsd > 0 ? +((size / liquidityUsd) * 100).toFixed(3) : null,
    protectedExecution: plan,
    tokenSafety: route.safety ?? { note: "Token honeypot/sell-tax status was not read this call — unknown, not clean. Use token-risk / sellability before routing." },
    recommendation:
      exposure === "high"
        ? "High sandwich exposure: this trade moves the pool enough to be worth front-running. Do NOT send it public as-is — use the protected-execution plan (tight min-out + private inclusion + split)."
        : exposure === "elevated"
          ? "Elevated exposure: worth protecting. A tight min-out and private inclusion remove most of the edge."
          : "Low sandwich exposure at this size and pool depth. A sensible min-out is still good hygiene; nothing here demands private routing.",
    note:
      "Estimates sandwich/front-run exposure for a specific swap from its price impact and size-vs-pool-depth, and returns a protected-execution plan (tight min-out, private/validity-tx inclusion, order splitting). " +
      (route.impactSource === "0x" ? "Impact is a live 0x quote. " : "Impact is a constant-product ESTIMATE (set ZEROX_API_KEY for a live quote). ") +
      (safetyUnknown ? "Token safety was not read this call. " : "") +
      "Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
