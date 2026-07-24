/**
 * Canonical response envelope — one vocabulary + one timestamp for the whole API.
 *
 * Services grew independently and diverged: verdicts landed under `verdict`,
 * `riskLevel`, `level`, `dangerLevel` or `decision`, with values from a dozen
 * different vocabularies, and timestamps as `checkedAt` / `generatedAt` /
 * `fetchedAt`. Consumers (the x402 gateway, gate, batch, position-health) each
 * hand-rolled the same field-sniffing to read them.
 *
 * This module centralizes that knowledge:
 *  - `finish()` stamps `checkedAt` so every response carries one timestamp field.
 *  - `riskSignal()` extracts a normalized {score, level, decision, degraded} from
 *    ANY handler output, tolerant of the historical field-name aliases — so the
 *    alias list lives in exactly one place.
 *  - `TokenRiskResult` / `TokenSecurity` are the shared shapes composites read,
 *    replacing four near-identical local copies.
 *
 * Migration is additive: handlers keep their existing fields, so external agents,
 * the mini-app and the catalog docs are unaffected.
 */

import "server-only";
import { createHash } from "node:crypto";

/** Pre-action decision gate. */
export type Decision = "go" | "hold" | "stop";

// ---- Decision receipt (axiombot spec) --------------------------------------
// An agent routes work to a check BY DEFAULT only if it can trust the check's
// decision quality across calls — not just that payment succeeded. That needs a
// machine-verifiable receipt: WHAT was evaluated (inputHash), under WHICH logic
// (policyVersion), how sure we are (confidence band), what a non-decision looks
// like (refusal shape), and when we don't charge for one (refund rule).
// This block is ADDITIVE — handlers keep every existing field.

/** Decision-logic version per endpoint. Bump when a check's scoring/rules change,
 * so an agent can detect that the policy behind a verdict moved between calls. */
export const POLICY_VERSION: Record<string, string> = {
  "token-risk": "1.2.0",
  "rug-score": "1.1.0",
  "sellability": "1.0.0",
};

/** Confidence in the verdict, derived from how complete the inputs were. */
export type ConfidenceBand = "high" | "medium" | "low";

export interface DecisionReceiptMeta {
  /** sha256 (truncated) of the canonical {endpoint + inputs} this verdict ran on. */
  inputHash: string;
  /** `endpoint@semver` of the decision logic that produced this verdict. */
  policyVersion: string;
  /** How sure the verdict is, and why. `low` when the core feed was unavailable. */
  confidence: { band: ConfidenceBand; basis: string };
  /** Structured non-decision: null on a real verdict; populated when we REFUSE. */
  refusal: { reason: string; missing: string[] } | null;
  /** Whether THIS call qualifies for a refund (a refusal is never billed on the
   * credit path — see refundRule). */
  refundable: boolean;
  /** The stated, enforced rule an agent can rely on. */
  refundRule: string;
}

/** True when a handler output is a refusal that must not be billed — the gateway
 * auto-refunds the credit debit and stamps `x-refunded` (see `refundRule`). */
export function isRefundable(data: unknown): boolean {
  const r = (data as { receipt?: { refundable?: unknown } } | null)?.receipt;
  return !!r && (r as { refundable?: unknown }).refundable === true;
}

/** Canonical, stable hash of what a check actually evaluated — lets an agent
 * dedupe, cache, and prove provenance of a verdict. Addresses are lowercased and
 * keys sorted so the same logical input always hashes identically. */
export function inputHash(endpoint: string, params: Record<string, unknown>): string {
  const norm: Record<string, unknown> = { endpoint };
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    norm[k] = typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v;
  }
  return "sha256:" + createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 32);
}

/** Build the standardized decision-receipt block. `degraded` (core feed down) →
 * confidence low + a structured refusal + refundable; `missing` secondary signals
 * → confidence medium; otherwise high. */
export function decisionReceipt(opts: {
  endpoint: string;
  params: Record<string, unknown>;
  degraded: boolean;
  /** Data that could not be consulted this call (drives confidence + refusal). */
  missing?: string[];
  /** Optional human-readable confidence rationale override. */
  confidenceBasis?: string;
}): DecisionReceiptMeta {
  const missing = opts.missing ?? [];
  const band: ConfidenceBand = opts.degraded ? "low" : missing.length ? "medium" : "high";
  const basis =
    opts.confidenceBasis ??
    (opts.degraded
      ? "core data feed unavailable this call — verdict is a partial read"
      : missing.length
        ? "primary checks ran; some secondary signals were unavailable"
        : "all declared inputs were consulted");
  return {
    inputHash: inputHash(opts.endpoint, opts.params),
    policyVersion: `${opts.endpoint}@${POLICY_VERSION[opts.endpoint] ?? "1.0.0"}`,
    confidence: { band, basis },
    refusal: opts.degraded ? { reason: "upstream_data_unavailable", missing } : null,
    refundable: opts.degraded,
    refundRule:
      "A refusal (confidence=low: our core data feed was unavailable) is not billed on the credit path — the debit is auto-refunded and x-refunded:true is returned. Full-confidence verdicts are final.",
  };
}
/** Risk severity. `unknown` = a required input could not be read this call. */
export type Severity = "low" | "medium" | "high" | "critical" | "unknown";

/**
 * Stamp `checkedAt` if the payload didn't already set it. Use as the final step
 * of a handler (`return finish({ ... })`) so the whole API shares one timestamp
 * field. A payload's own `checkedAt` (or other keys) always wins.
 */
export function finish<T extends Record<string, unknown>>(payload: T): T & { checkedAt: string } {
  return { checkedAt: new Date().toISOString(), ...payload } as T & { checkedAt: string };
}

/**
 * Normalized risk signal extracted from any handler output, tolerant of the
 * historical field divergence (riskScore/rugScore/score, riskLevel/level/
 * dangerLevel, decision/verdict). `degraded` reflects an upstream that couldn't
 * be read (also inferred from a level/decision of "unknown").
 */
export function riskSignal(data: unknown): {
  score: number | null;
  level: string | null;
  decision: string | null;
  degraded: boolean;
} {
  const d = (data ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const level = str(d.riskLevel) ?? str(d.level) ?? str(d.dangerLevel);
  const decision = str(d.decision) ?? str(d.verdict);
  return {
    score: num(d.riskScore) ?? num(d.rugScore) ?? num(d.score),
    level,
    decision,
    degraded: d.degraded === true || level === "unknown" || decision === "unknown",
  };
}

/** Sort rank for severity levels (riskiest first); unknown ranks just under high. */
export function severityRank(level: string | null | undefined): number {
  switch (level) {
    case "critical": return 0;
    case "high": return 1;
    case "unknown": return 2; // couldn't assess → treat as elevated, not safe
    case "medium": return 3;
    case "low": return 4;
    default: return 5;
  }
}

// ---- Shared upstream shapes (the fields composites read off tokenRisk) ----

export interface TokenSecurity {
  isHoneypot?: boolean;
  buyTaxPct?: number | null;
  sellTaxPct?: number | null;
  transferPausable?: boolean;
  creatorAddress?: string | null;
  creatorPct?: number | null;
  holderCount?: number | null;
}

export interface TokenRiskResult {
  address?: string;
  riskScore?: number;
  riskLevel?: string;
  flags?: string[];
  ownership?: { owner?: string | null; renounced?: boolean | null };
  security?: TokenSecurity | null;
  /** false → the security feed (honeypot/tax/holders) was NOT consulted this call. */
  securityChecked?: boolean;
  degraded?: boolean;
  sources?: string[];
}

/** Did tokenRisk actually consult the security feed? Tolerant of older outputs. */
export function securityChecked(risk: TokenRiskResult | null | undefined): boolean {
  if (!risk) return false;
  return risk.securityChecked ?? (Array.isArray(risk.sources) && risk.sources.includes("goplus"));
}
