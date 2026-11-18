/**
 * token-verdict — the one call an agent makes before it buys a Base token.
 *
 * The catalogue already has the deepest pre-trade stack in x402 (token-risk,
 * sellability, owner-powers, dump-risk, b20-gate, deployer-rep — composed by
 * pre-trade-bundle). But depth is not what an agent polls: it wants ONE answer,
 * fast, in a shape it can branch on. This distils the whole composite to a single
 * verdict — SAFE / CAUTION / AVOID — with the reasons behind it, a confidence, a
 * max safe size and a shareable card. Same engine, one decision.
 *
 * Billing follows the bundle underneath: the composite's receipt is passed
 * through unchanged, so a degraded read (a gating check that could not run) is a
 * refusal here too — refundable, never a false "SAFE".
 */

import "server-only";
import { getAddress } from "viem";
import { preTradeBundle } from "./pre-trade-bundle";
import { getSiteUrl } from "./config";

type Verdict = "SAFE" | "CAUTION" | "AVOID" | "UNKNOWN";

const FROM_DECISION: Record<string, Verdict> = { GO: "SAFE", HOLD: "CAUTION", STOP: "AVOID" };

const HEADLINE: Record<Verdict, string> = {
  SAFE: "Looks clean — every applicable pre-trade check passed.",
  CAUTION: "Tradeable, but with real risks — size down and stay exit-ready.",
  AVOID: "Do not trade — a terminal flag is set (honeypot, seize/freeze, or critical owner power).",
  UNKNOWN: "Not verified — one or more safety checks could not run. Re-check before trading.",
};

export async function tokenVerdict(params: Record<string, string>) {
  const raw = (params.address || params.token || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… Base token address (address=)");
  const address = getAddress(raw);

  // Reuse the composite (the FUNCTION, not the paid endpoint — no double charge).
  const b = await preTradeBundle(params);

  const verdict: Verdict = b.degraded ? "UNKNOWN" : FROM_DECISION[b.decision] ?? "UNKNOWN";
  const confidence = b.receipt?.confidence?.band ?? "low";
  const reasons =
    b.observedRisks.length > 0
      ? b.observedRisks.slice(0, 4)
      : b.positives.length > 0
        ? b.positives.slice(0, 3)
        : ["Every applicable safety check ran and came back clean."];
  const recommendedMaxSizeUsd =
    typeof (b.sizing as { recommendedMaxSizeUsd?: unknown }).recommendedMaxSizeUsd === "number"
      ? ((b.sizing as { recommendedMaxSizeUsd: number }).recommendedMaxSizeUsd)
      : null;

  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const card = `${short} → ${verdict} (${confidence} confidence). ${reasons[0]}`;

  // A link to the shareable PNG of THIS verdict. The card route is a pure
  // renderer (it draws these params, never recomputes), so linking it is free.
  const cardUrl =
    `${getSiteUrl()}/brand/verdict?v=${verdict}&addr=${address}&conf=${confidence}` +
    `&size=${recommendedMaxSizeUsd ?? ""}&reason=${encodeURIComponent(reasons[0] ?? "")}`;

  return {
    address,
    verdict, // SAFE | CAUTION | AVOID | UNKNOWN
    confidence, // high | medium | low
    headline: HEADLINE[verdict],
    reasons,
    recommendedMaxSizeUsd,
    /** The full composite, for agents that want the per-check detail. */
    detail: {
      decision: b.decision,
      checks: b.checks,
      observedRisks: b.observedRisks,
      positives: b.positives,
      sizing: b.sizing,
    },
    /** A one-line, shareable summary. */
    card,
    /** A 1200×630 PNG of this verdict, ready to embed or post. */
    cardUrl,
    // Pass the composite's receipt through unchanged so the x402/credit rails
    // apply the SAME billing + refund-on-degraded semantics.
    receipt: b.receipt,
    checkedAt: new Date().toISOString(),
  };
}
