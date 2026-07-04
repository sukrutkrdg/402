/**
 * Free-tier teaser.
 *
 * Turns a full service result into a preview: keep the headline scalars a caller
 * needs to feel the value (score, level, verdict, booleans, symbol, address),
 * reduce every detail array to just its COUNT ("3 signals found", not what they
 * are), and drop the prose and nested detail blocks. The actual signals, flags,
 * factors, holders, pool, recommendation and summary are what a PAID call
 * unlocks — this is the shop window, not the goods.
 */

import "server-only";

// Prose/value fields hidden entirely in a preview (the paid report's payoff).
const HIDDEN_KEYS = new Set(["recommendation", "summary", "advice", "note", "explanation", "verdict_reason"]);
// Scalar strings longer than this are truncated (long free-text is a value field).
const MAX_STR = 160;

export function toPreview(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(data as Record<string, unknown>)) {
    if (HIDDEN_KEYS.has(key)) continue;
    if (Array.isArray(v)) {
      // Reveal HOW MANY, hide WHAT — the detail is the paid value.
      out[`${key}Count`] = v.length;
    } else if (v && typeof v === "object") {
      // Nested detail blocks (bestPool, exit, creatorProfile, …) stay locked.
      continue;
    } else if (typeof v === "string" && v.length > MAX_STR) {
      out[key] = v.slice(0, MAX_STR).trimEnd() + "…";
    } else {
      // Headline scalars: score, level, verdict, booleans, symbol, address, dates.
      out[key] = v;
    }
  }
  return out;
}
