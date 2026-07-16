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

/** Pre-action decision gate. */
export type Decision = "go" | "hold" | "stop";
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
