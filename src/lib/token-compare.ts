/**
 * Token Compare — "of these tokens, which one should I actually buy?"
 *
 * Agents rarely evaluate one token in a vacuum; they choose between candidates.
 * This scores 2-5 Base tokens side by side — rug probability, liquidity depth,
 * and momentum — into a single comparable 0-100 quality score per token, ranks
 * them, and names the pick (or says none are tradeable). One call replaces a
 * dozen and returns a decision, not a data dump. Free upstreams.
 */

import "server-only";
import { rugScore } from "./scores";
import { tokenMomentum } from "./market";

interface RugShape {
  rugScore?: number;
  level?: string;
  signals?: string[];
}
interface MomentumShape {
  symbol?: string | null;
  priceUsd?: string | null;
  liquidityUsd?: number | null;
  trend?: string;
  priceChange?: { h24?: number | null };
}

export async function tokenCompare(params: Record<string, string>) {
  const addresses = (params.addresses || params.address || "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (addresses.length < 2 || addresses.length > 5) {
    throw new Error("Provide 2-5 comma-separated token addresses to compare");
  }
  for (const a of addresses) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`Invalid address: ${a}`);
  }

  const results = await Promise.all(
    addresses.map(async (address) => {
      const [rugR, momR] = await Promise.allSettled([rugScore({ address }), tokenMomentum({ address })]);
      const rug = (rugR.status === "fulfilled" ? rugR.value : null) as RugShape | null;
      const mom = (momR.status === "fulfilled" ? momR.value : null) as MomentumShape | null;

      if (!rug && !mom) {
        return { address, symbol: null, qualityScore: null, tradeable: false, reason: "No on-chain data found for this token." };
      }

      // Quality = safety first (rug score inverted), then depth, then momentum.
      let score = rug?.rugScore !== undefined ? 100 - rug.rugScore : 50;
      const liq = mom?.liquidityUsd ?? null;
      if (liq !== null) {
        if (liq >= 250000) score += 10;
        else if (liq >= 50000) score += 5;
        else if (liq < 5000) score -= 10;
      }
      const trend = mom?.trend ?? "unknown";
      if (trend === "strong_up") score += 6;
      else if (trend === "up") score += 3;
      else if (trend === "down") score -= 3;
      else if (trend === "strong_down") score -= 6;
      score = Math.max(0, Math.min(100, Math.round(score)));

      const tradeable = rug?.level !== "high" && (liq === null || liq >= 2000);
      return {
        address,
        symbol: mom?.symbol ?? null,
        qualityScore: score, // 0-100, higher = better risk-adjusted candidate
        tradeable,
        rugScore: rug?.rugScore ?? null,
        rugLevel: rug?.level ?? null,
        liquidityUsd: liq,
        priceUsd: mom?.priceUsd ?? null,
        priceChange24h: mom?.priceChange?.h24 ?? null,
        trend,
        topSignals: (rug?.signals ?? []).slice(0, 3),
        reason: !tradeable
          ? rug?.level === "high"
            ? "Fails the safety gate (high rug score)."
            : "Liquidity too thin to trade."
          : undefined,
      };
    }),
  );

  const ranked = [...results].sort((a, b) => (b.qualityScore ?? -1) - (a.qualityScore ?? -1));
  const pick = ranked.find((r) => r.tradeable && r.qualityScore !== null) ?? null;

  return {
    compared: addresses.length,
    ranking: ranked, // best first
    pick: pick ? { address: pick.address, symbol: pick.symbol, qualityScore: pick.qualityScore } : null,
    recommendation: pick
      ? `${pick.symbol ?? pick.address} ranks best: quality ${pick.qualityScore}/100 (rug ${pick.rugScore}/100, $${Math.round(pick.liquidityUsd ?? 0).toLocaleString()} liquidity, trend ${pick.trend}).`
      : "None of the compared tokens pass the safety/liquidity gate — don't force a pick.",
    note: "Quality score weighs safety (inverted rug score) over liquidity depth over momentum. A ranking is relative — the best of a bad set is still bad; check `tradeable`. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
