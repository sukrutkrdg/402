import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * pre-trade-gate failure discipline: GO must mean "every check RAN and came back
 * clean". Regression for the audit HIGH where a provider outage was coerced into
 * a benign value and a $0.10 gate answered GO on a token nothing was verified on.
 */
const { tokenRiskMock, sellabilityMock, swapRouteMock, deployerMock } = vi.hoisted(() => ({
  tokenRiskMock: vi.fn(),
  sellabilityMock: vi.fn(),
  swapRouteMock: vi.fn(),
  deployerMock: vi.fn(),
}));
vi.mock("@/lib/onchain", () => ({ tokenRisk: tokenRiskMock }));
vi.mock("@/lib/sellability", () => ({ sellability: sellabilityMock }));
vi.mock("@/lib/swap-route", () => ({ swapRoute: swapRouteMock }));
vi.mock("@/lib/deployer-rep", () => ({ deployerReputation: deployerMock }));
const { guardMock } = vi.hoisted(() => ({ guardMock: vi.fn(() => ({ available: false, reason: "test" })) }));
vi.mock("@/lib/liquidity-guard", () => ({ buildLiquidityGuard: async () => guardMock() }));

import { preTradeGate } from "@/lib/gate";

const TOKEN = "0x1111111111111111111111111111111111111111";

function cleanChecks() {
  tokenRiskMock.mockResolvedValue({
    riskScore: 5,
    riskLevel: "low",
    sources: ["base-rpc", "goplus"],
    security: { isHoneypot: false, sellTaxPct: 0 },
    ownership: { renounced: true },
  });
  sellabilityMock.mockResolvedValue({ canSell: true, sellTaxPct: 0 });
  swapRouteMock.mockResolvedValue({ estPriceImpactPct: 0.4, verdict: "ok" });
  deployerMock.mockResolvedValue({ reputation: "trusted", reputationScore: 92 });
}

interface GateResult {
  decision: string;
  degraded?: boolean;
  unverifiedChecks?: string[];
  receipt: { observedRisks: string[] };
}

describe("pre-trade-gate — GO only when everything was actually checked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanChecks();
  });

  it("returns GO when all four checks run clean", async () => {
    const r = (await preTradeGate({ address: TOKEN })) as GateResult;
    expect(r.decision).toBe("GO");
    expect(r.degraded).toBeUndefined();
  });

  it("never answers GO when every upstream is down — HOLD + degraded", async () => {
    tokenRiskMock.mockRejectedValue(new Error("rpc down"));
    sellabilityMock.mockRejectedValue(new Error("goplus down"));
    swapRouteMock.mockRejectedValue(new Error("dex down"));
    deployerMock.mockRejectedValue(new Error("covalent down"));
    const r = (await preTradeGate({ address: TOKEN })) as GateResult;
    expect(r.decision).toBe("HOLD");
    expect(r.degraded).toBe(true);
    expect(r.unverifiedChecks).toHaveLength(4);
  });

  it("degrades to HOLD when token-risk ran WITHOUT its honeypot source (GoPlus)", async () => {
    tokenRiskMock.mockResolvedValue({
      riskScore: 10,
      riskLevel: "low",
      sources: ["base-rpc"], // GoPlus missing → honeypot never actually checked
      security: {},
      ownership: { renounced: true },
    });
    const r = (await preTradeGate({ address: TOKEN })) as GateResult;
    expect(r.decision).toBe("HOLD");
    expect(r.degraded).toBe(true);
    expect(r.unverifiedChecks?.join()).toMatch(/GoPlus/i);
  });

  it("a missing risk score is unknown, not 50: no phantom 'high risk', but no GO either", async () => {
    tokenRiskMock.mockRejectedValue(new Error("down"));
    const r = (await preTradeGate({ address: TOKEN })) as GateResult;
    expect(r.decision).toBe("HOLD");
    expect(r.receipt.observedRisks.join()).not.toMatch(/high token-risk score/);
  });

  it("honeypot is terminal — STOP", async () => {
    tokenRiskMock.mockResolvedValue({
      riskScore: 30,
      riskLevel: "medium",
      sources: ["base-rpc", "goplus"],
      security: { isHoneypot: true, sellTaxPct: 0 },
      ownership: { renounced: true },
    });
    const r = (await preTradeGate({ address: TOKEN })) as GateResult;
    expect(r.decision).toBe("STOP");
  });

  it("a high_risk (serial rugger) deployer is terminal — STOP, not HOLD", async () => {
    deployerMock.mockResolvedValue({ reputation: "high_risk", reputationScore: 3 });
    const r = (await preTradeGate({ address: TOKEN })) as GateResult;
    expect(r.decision).toBe("STOP");
  });

  it("rejects a garbage trade size instead of emitting NaN", async () => {
    await expect(preTradeGate({ address: TOKEN, amountUsd: "banana" })).rejects.toThrow(/positive number/);
  });
});

describe("pre-trade-gate enforce (Cobalt liquidity guard)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the guard through on GO", async () => {
    cleanChecks();
    guardMock.mockReturnValueOnce({ available: true, validity: [{ type: "storage", params: {} }] } as never);
    const r = (await preTradeGate({ address: TOKEN })) as unknown as { decision: string; enforce: { available: boolean } };
    expect(r.decision).toBe("GO");
    expect(r.enforce.available).toBe(true);
  });

  it("offers no guard on STOP — there is no trade to protect", async () => {
    cleanChecks();
    sellabilityMock.mockResolvedValue({ canSell: false, sellTaxPct: 100 });
    guardMock.mockReturnValueOnce({ available: true, validity: [] } as never);
    const r = (await preTradeGate({ address: TOKEN })) as unknown as { decision: string; enforce: { available: boolean } };
    expect(r.decision).toBe("STOP");
    expect(r.enforce.available).toBe(false);
  });

  it("refuses an out-of-range drop tolerance as the caller's input", async () => {
    cleanChecks();
    await expect(preTradeGate({ address: TOKEN, maxLiquidityDropPct: "95" })).rejects.toThrow(/between 1 and 90/);
  });
});
