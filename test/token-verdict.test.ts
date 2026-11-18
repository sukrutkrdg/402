import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * token-verdict is a thin distillation of pre-trade-bundle, so the contract is
 * the mapping: GO→SAFE, HOLD→CAUTION, STOP→AVOID, degraded→UNKNOWN — and the
 * composite's receipt passed through unchanged so billing/refund stays identical.
 */
const { bundleMock } = vi.hoisted(() => ({ bundleMock: vi.fn() }));
vi.mock("@/lib/pre-trade-bundle", () => ({ preTradeBundle: bundleMock }));

import { tokenVerdict } from "@/lib/token-verdict";

const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";

function bundle(over: Record<string, unknown> = {}) {
  return {
    address: DEGEN,
    decision: "GO",
    unverified: [],
    checks: {},
    observedRisks: [] as string[],
    positives: ["clean"] as string[],
    sizing: { recommendedMaxSizeUsd: 1000 },
    receipt: { confidence: { band: "high" } },
    recommendation: "",
    note: "",
    checkedAt: "x",
    ...over,
  };
}

describe("token-verdict", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps GO → SAFE with the max size, a confidence and a card", async () => {
    bundleMock.mockResolvedValue(bundle({ decision: "GO", observedRisks: [], positives: ["LP is locked"] }));
    const r = await tokenVerdict({ address: DEGEN });
    expect(r.verdict).toBe("SAFE");
    expect(r.confidence).toBe("high");
    expect(r.recommendedMaxSizeUsd).toBe(1000);
    expect(r.reasons[0]).toBe("LP is locked");
    expect(r.card).toMatch(/SAFE/);
    expect(r.receipt).toBeDefined();
  });

  it("maps HOLD → CAUTION and surfaces the observed risks as the reasons", async () => {
    bundleMock.mockResolvedValue(bundle({ decision: "HOLD", observedRisks: ["[dump-risk] exit trap", "[owner-powers] mint"] }));
    const r = await tokenVerdict({ address: DEGEN });
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons).toEqual(["[dump-risk] exit trap", "[owner-powers] mint"]);
  });

  it("maps STOP → AVOID", async () => {
    bundleMock.mockResolvedValue(bundle({ decision: "STOP", observedRisks: ["[gate] honeypot"] }));
    expect((await tokenVerdict({ address: DEGEN })).verdict).toBe("AVOID");
  });

  it("a degraded composite is UNKNOWN — never a false SAFE/CAUTION", async () => {
    bundleMock.mockResolvedValue(bundle({ decision: "HOLD", degraded: true, observedRisks: [] }));
    expect((await tokenVerdict({ address: DEGEN })).verdict).toBe("UNKNOWN");
  });

  it("rejects a bad address before doing any work", async () => {
    await expect(tokenVerdict({ address: "0x123" })).rejects.toThrow(/valid 0x/);
    expect(bundleMock).not.toHaveBeenCalled();
  });

  it("passes the composite receipt through unchanged (billing/refund parity)", async () => {
    const receipt = { confidence: { band: "medium" }, refusal: { reason: "gating_check_unverified" } };
    bundleMock.mockResolvedValue(bundle({ decision: "HOLD", degraded: true, receipt }));
    expect((await tokenVerdict({ address: DEGEN })).receipt).toBe(receipt);
  });
});
