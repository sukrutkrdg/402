/**
 * NEAR pre-trade gate — the one call before an agent buys a NEP-141 token.
 * The NEAR counterpart of pre-trade-gate: one GO / HOLD / STOP from two
 * questions, each of which can stop the trade on its own.
 *
 *   1. Who controls the token?  near-token-safety: keys, owner, pause.
 *   2. Can you get back out?    A round trip through NEAR Intents at the
 *      trade size — buy with USDC, sell straight back — and what it costs.
 *      A token you cannot sell, or can only sell at a steep loss, is the
 *      honeypot shape; no route at all means the exit is unproven.
 *
 * Round-trip loss thresholds: over 15% → STOP, over 5% → HOLD. The worse of
 * the two answers is the verdict.
 */

import "server-only";
import { nearTokenSafety } from "./near-token-safety";
import { intentsTokens, findNearToken, parseUnits } from "./near-rpc";
import { dryQuote, resolveAsset, type QuoteResult } from "./near-swap-quote";

type Verdict = "GO" | "HOLD" | "STOP";
const rank: Record<Verdict, number> = { GO: 0, HOLD: 1, STOP: 2 };
const worse = (a: Verdict, b: Verdict): Verdict => (rank[b] > rank[a] ? b : a);

const STOP_LOSS_PCT = 15;
const HOLD_LOSS_PCT = 5;

export async function nearPreTradeGate(params: Record<string, string>) {
  const sizeUsd = params.size ? Number(params.size) : 100;
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0 || sizeUsd > 1_000_000) {
    throw new Error("size is the trade size in USD, e.g. 100 (default)");
  }

  // Validates the token id too — throws before anything else is spent.
  const safety = await nearTokenSafety({ token: params.token });
  const reasons: string[] = [...safety.reasons];
  let verdict: Verdict = safety.verdict;

  const base = {
    chain: "near" as const,
    token: safety.token,
    sizeUsd,
    checkedAt: safety.checkedAt,
    safety: {
      verdict: safety.verdict,
      ...("metadata" in safety ? { metadata: safety.metadata, control: safety.control } : {}),
    },
  };

  if (safety.verdict === "STOP") {
    return { ...base, verdict, reasons, route: null };
  }

  const tokens = await intentsTokens();
  const target = tokens ? findNearToken(tokens, safety.token) : undefined;
  const usdc = tokens ? resolveAsset(tokens, "USDC") : { error: "list unavailable" };

  let route: { buy: QuoteResult; sell: QuoteResult; roundTripLossPct: number | null } | null = null;
  if (!tokens || "error" in usdc) {
    verdict = worse(verdict, "HOLD");
    reasons.push("NEAR Intents is unreachable, so whether you can exit this token was not tested.");
  } else if (!target) {
    verdict = worse(verdict, "HOLD");
    reasons.push("No NEAR Intents route for this token — the exit is unproven; you may be unable to sell it.");
  } else if (target.assetId === usdc.assetId) {
    reasons.push("This is the USDC the round trip is measured in — no exit test needed.");
  } else {
    const spend = parseUnits(String(sizeUsd), usdc.decimals)!;
    try {
      const buy = await dryQuote(usdc, target, spend);
      const sell = await dryQuote(target, usdc, buy.amountOutRaw);
      const back = sell.amountOutUsd ?? Number(sell.amountOut);
      const loss = +(((sizeUsd - back) / sizeUsd) * 100).toFixed(2);
      route = { buy, sell, roundTripLossPct: loss };
      if (loss > STOP_LOSS_PCT) {
        verdict = "STOP";
        reasons.push(`Round trip loses ${loss}%: $${sizeUsd} in, about $${back.toFixed(2)} back — too thin or too costly to exit.`);
      } else if (loss > HOLD_LOSS_PCT) {
        verdict = worse(verdict, "HOLD");
        reasons.push(`Round trip loses ${loss}% at $${sizeUsd} — exit is possible but costly; try a smaller size.`);
      } else {
        reasons.push(`Exit tested: $${sizeUsd} in and straight back out loses ${loss}%.`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/not charged/.test(msg)) throw e; // our outage: refund, do not guess a verdict
      verdict = worse(verdict, "HOLD");
      reasons.push(`NEAR Intents would not quote the round trip (${msg.replace(/^No quote: /, "")}) — the exit is unproven at this size.`);
    }
  }

  return { ...base, verdict, reasons, route };
}
