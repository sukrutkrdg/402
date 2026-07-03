/**
 * Position Health — "I'm IN this token: how is the position doing, and should I
 * stay in?"
 *
 * Every other check is pre-trade; this one is post-trade. Given a token, a
 * position size and (optionally) an entry price, it combines live price & P&L,
 * whether the position can still be EXITED at this size, and the token's current
 * rug score into one hold / watch / exit read. The risk that changes after you
 * buy — liquidity draining, flags appearing — is exactly the risk holders miss.
 * Free upstreams (DexScreener + GoPlus).
 */

import "server-only";
import { tokenPrice } from "./onchain-extra";
import { exitLiquidity } from "./liquidity";
import { rugScore } from "./scores";

interface PriceShape {
  priceUsd?: string | null;
  priceChange24h?: number | null;
  liquidityUsd?: number | null;
}
interface ExitShape {
  estSellImpactPct?: number;
  canExit?: boolean;
  maxSafeExitUsd?: number;
  exitRisk?: string;
}
interface RugShape {
  rugScore?: number;
  level?: string;
  signals?: string[];
}

export async function positionHealth(params: Record<string, string>) {
  const address = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Provide a valid 0x… token contract address");
  const sizeUsd = Math.max(0, parseFloat(params.size || params.sizeUsd || "1000") || 1000);
  const entryPrice = parseFloat(params.entryPrice || "");
  const hasEntry = Number.isFinite(entryPrice) && entryPrice > 0;

  // Price is the load-bearing read — no price, no position to assess (throws
  // pre-settlement, buyer isn't charged). Exit + rug are best-effort context.
  const price = (await tokenPrice({ address })) as PriceShape;
  const [exitR, rugR] = await Promise.allSettled([
    exitLiquidity({ address, size: String(sizeUsd) }),
    rugScore({ address }),
  ]);
  const exit = (exitR.status === "fulfilled" ? exitR.value : null) as ExitShape | null;
  const rug = (rugR.status === "fulfilled" ? rugR.value : null) as RugShape | null;

  const currentPrice = price.priceUsd ? parseFloat(price.priceUsd) : null;
  const pnlPct =
    hasEntry && currentPrice !== null ? +(((currentPrice - entryPrice) / entryPrice) * 100).toFixed(2) : null;
  const positionValueUsd =
    pnlPct !== null ? +(sizeUsd * (1 + pnlPct / 100)).toFixed(2) : sizeUsd;

  const reasons: string[] = [];
  if (rug?.level === "high") reasons.push(`Rug score is HIGH (${rug.rugScore}/100): ${(rug.signals || []).slice(0, 4).join(", ")}.`);
  else if (rug?.level === "medium") reasons.push(`Rug score is medium (${rug?.rugScore}/100).`);
  if (exit && exit.canExit === false)
    reasons.push(`Position can no longer be exited cleanly — unwinding ~$${Math.round(positionValueUsd)} costs ~${exit.estSellImpactPct}% impact.`);
  else if (exit && (exit.estSellImpactPct ?? 0) >= 5)
    reasons.push(`Exit impact is ${exit.estSellImpactPct}% at this size — the door is narrowing.`);
  if ((price.liquidityUsd ?? Infinity) < 5000) reasons.push(`Pool liquidity is down to $${Math.round(price.liquidityUsd ?? 0)}.`);
  if (pnlPct !== null && pnlPct <= -50) reasons.push(`Position is down ${pnlPct}% from entry.`);

  // Verdict: a high rug score or a blocked exit means get out while you still
  // can; medium risk or a narrowing exit means watch; otherwise hold.
  const exitNow = rug?.level === "high" || (exit ? exit.canExit === false : false);
  const watch =
    rug?.level === "medium" ||
    (exit ? (exit.estSellImpactPct ?? 0) >= 5 : false) ||
    (price.liquidityUsd ?? Infinity) < 5000 ||
    (pnlPct !== null && pnlPct <= -50);
  const verdict: "exit_now" | "watch" | "healthy" = exitNow ? "exit_now" : watch ? "watch" : "healthy";

  return {
    address,
    positionSizeUsd: sizeUsd,
    entryPriceUsd: hasEntry ? entryPrice : null,
    currentPriceUsd: currentPrice,
    pnlPct, // null if no entry price supplied
    positionValueUsd,
    priceChange24h: price.priceChange24h ?? null,
    liquidityUsd: price.liquidityUsd ?? null,
    exit: exit
      ? { canExit: exit.canExit ?? null, estSellImpactPct: exit.estSellImpactPct ?? null, maxSafeExitUsd: exit.maxSafeExitUsd ?? null, exitRisk: exit.exitRisk ?? null }
      : null,
    rug: rug ? { score: rug.rugScore ?? null, level: rug.level ?? null } : null,
    verdict, // healthy | watch | exit_now
    reasons,
    recommendation:
      verdict === "exit_now"
        ? "Exit while the pool can still absorb it — current risk/exit conditions say the position should not be held."
        : verdict === "watch"
          ? "Hold with a tight watch — risk or exit conditions have degraded. Consider trimming toward the max safe exit size."
          : "Position looks healthy: exitable at this size with no elevated rug signals.",
    note: "Post-trade check: live price/P&L + exit feasibility + current rug score in one call. Conditions change block to block — re-check before acting. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
