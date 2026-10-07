/**
 * Agent pay gate — "I am about to pay 0x… $X, go?"
 *
 * safe-to-send already screens a recipient (OFAC, identity, wallet-vs-contract,
 * fresh-burner age) and is the right core, so this does NOT re-implement it — it
 * CALLS it and adds the two things a PAYMENT decision needs that a generic
 * send-screen does not carry:
 *
 *   1. Amount sanity. A first payment of a few cents to a fresh address is how
 *      agents sample x402 sellers; the same fresh address receiving a large
 *      amount is the loss safe-to-send's age caution is trying to prevent. So the
 *      optional usd amount sharpens the verdict rather than sitting beside it: a
 *      REVIEW-level freshness becomes STOP-worthy once the amount is material.
 *   2. Payment framing. The verdict is phrased for the act of sending USDC now,
 *      with the amount and recipient echoed, so an agent can branch on it without
 *      re-reading a factor map.
 *
 * It never loosens safe-to-send: a STOP there is a STOP here. It only tightens,
 * and only when an amount makes an otherwise-tolerable caution material.
 */

import "server-only";
import { getAddress } from "viem";
import { safeToSend } from "./safe-to-send";

/** Above this, a fresh/anonymous recipient is treated as a hard STOP rather than
 *  a REVIEW: a throwaway address receiving real size is the drain this guards. */
export const MATERIAL_USD = 100;

/**
 * The escalation rule, isolated and pure so it can be tested without a chain.
 * Given the underlying safe-to-send verdict, whether the recipient is
 * fresh/anonymous, and the amount, decide the pay-gate verdict. It only ever
 * TIGHTENS safe-to-send (a STOP stays STOP); it escalates REVIEW→STOP when a
 * material amount meets a fresh/anonymous recipient, and never loosens.
 */
export function payGateDecision(
  recipientScreen: string,
  freshOrAnon: boolean,
  usd: number | null,
): "GO" | "REVIEW" | "STOP" {
  if (recipientScreen === "STOP") return "STOP";
  const base: "GO" | "REVIEW" = recipientScreen === "GO" ? "GO" : "REVIEW";
  const material = usd !== null && usd >= MATERIAL_USD;
  if (base !== "GO" && material && freshOrAnon) return "STOP";
  return base;
}

export async function agentPayGate(params: Record<string, string>) {
  const raw = (params.to || params.address || params.recipient || params.payTo || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide the address you are about to pay (to=0x…)");
  const to = getAddress(raw);

  const amountStr = (params.usd || params.amount || "").trim();
  const usd = amountStr ? Number(amountStr) : null;
  if (amountStr && (!Number.isFinite(usd) || (usd as number) < 0)) throw new Error("usd must be a non-negative number (the amount you are about to send)");
  const material = usd !== null && usd >= MATERIAL_USD;

  const s = (await safeToSend({ address: to })) as {
    verdict?: string;
    guidance?: string;
    degraded?: boolean;
    factors?: Record<string, { level: string; reason: string }>;
  };
  const base = s.verdict ?? "unknown";

  // The freshness/anonymity cautions that a material amount should escalate.
  const ageLevel = s.factors?.age?.level;
  const idLevel = s.factors?.identity?.level;
  const freshOrAnon = ageLevel === "caution" || idLevel === "caution";

  const decision = payGateDecision(base, freshOrAnon, usd);
  const notes: string[] = [];
  if (decision === "STOP" && base !== "STOP") {
    notes.push(`The recipient is fresh/anonymous and you are sending $${usd} (≥ $${MATERIAL_USD}). For a throwaway-risk address this size is the loss to avoid — send a tiny test amount first, or verify the recipient out of band.`);
  }
  if (usd !== null && !material && freshOrAnon) {
    notes.push(`Recipient is fresh/anonymous but $${usd} is small — acceptable as a first/test payment, not for size.`);
  }

  return {
    to,
    usd,
    decision, // GO | REVIEW | STOP
    recipientScreen: base, // the underlying safe-to-send verdict
    degraded: Boolean(s.degraded),
    factors: s.factors,
    reasons: [...(s.guidance ? [s.guidance] : []), ...notes],
    recommendation:
      decision === "STOP"
        ? `Do NOT send${usd !== null ? ` $${usd}` : ""} to ${to}.`
        : decision === "REVIEW"
          ? `Review before sending${usd !== null ? ` $${usd}` : ""} — a signal is unconfirmed or cautionary.`
          : `No adverse signal for ${to}. Identity is not intent: this says the payee is not known-bad or a throwaway, not that the payment is correct.`,
    note: "Pre-payment gate for an agent about to send USDC: wraps the safe-to-send recipient screen (OFAC, identity, wallet-vs-contract, fresh-address age) and escalates a fresh/anonymous recipient to STOP once the amount is material. Pass usd= for amount-aware guidance. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
