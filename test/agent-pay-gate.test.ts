/**
 * The pay-gate escalation rule. It wraps safe-to-send and must ONLY tighten:
 * a STOP stays STOP, a clean GO stays GO, and a fresh/anonymous recipient
 * escalates to STOP only once the amount is material.
 */

import { describe, it, expect } from "vitest";
import { payGateDecision, MATERIAL_USD } from "@/lib/agent-pay-gate";

describe("agent pay gate decision", () => {
  it("never loosens: a safe-to-send STOP is always STOP", () => {
    expect(payGateDecision("STOP", true, 1)).toBe("STOP");
    expect(payGateDecision("STOP", false, null)).toBe("STOP");
  });

  it("a clean GO stays GO regardless of amount", () => {
    expect(payGateDecision("GO", false, 1_000_000)).toBe("GO");
  });

  it("escalates REVIEW→STOP when a material amount meets a fresh/anonymous recipient", () => {
    expect(payGateDecision("REVIEW", true, MATERIAL_USD)).toBe("STOP");
    expect(payGateDecision("REVIEW", true, MATERIAL_USD + 50)).toBe("STOP");
  });

  it("keeps REVIEW for a small amount to a fresh recipient (sampling is fine)", () => {
    expect(payGateDecision("REVIEW", true, 1)).toBe("REVIEW");
  });

  it("keeps REVIEW when the recipient is not fresh/anonymous, even for size", () => {
    expect(payGateDecision("REVIEW", false, 10_000)).toBe("REVIEW");
  });

  it("does not escalate when no amount is given (unknown size is not material)", () => {
    expect(payGateDecision("REVIEW", true, null)).toBe("REVIEW");
  });
});
