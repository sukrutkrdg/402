import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * pre-trade-gate, tokenized-stock path. Before it, every Coinbase stock read
 * HOLD ("unverified: GoPlus, sellability, deployer") because those checks cannot
 * read a B20 precompile — measured on NVDAc 2026-10-17.
 */
const m = vi.hoisted(() => ({
  tokenRisk: vi.fn(),
  fv: vi.fn(),
  route: vi.fn(),
  policy: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@/lib/onchain", () => ({ tokenRisk: m.tokenRisk }));
vi.mock("@/lib/sellability", () => ({ sellability: vi.fn() }));
vi.mock("@/lib/deployer-rep", () => ({ deployerReputation: vi.fn() }));
vi.mock("@/lib/swap-route", () => ({ swapRoute: m.route }));
vi.mock("@/lib/stock-fair-value", () => ({ stockFairValue: m.fv }));
vi.mock("@/lib/liquidity-guard", () => ({ buildLiquidityGuard: async () => ({ available: false, reason: "test" }) }));
vi.mock("@/lib/tokenized-stocks", async (orig) => ({ ...(await orig<object>()), readTransferPolicy: m.policy }));
vi.mock("viem", async (orig) => {
  const v = await orig<typeof import("viem")>();
  return { ...v, createPublicClient: () => ({ readContract: m.read }) };
});

import { preTradeGate } from "@/lib/gate";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const WALLET = "0x2222222222222222222222222222222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  m.fv.mockResolvedValue({ session: "closed", referenceFrozen: true, reference: { price: 214 }, dex: { priceUsd: 214.2 }, premiumBps: 9, verdict: "fair", referenceStale: false, pausedFeatures: [], pendingCorporateAction: null });
  m.route.mockResolvedValue({ estPriceImpactPct: 0.1, verdict: "ok" });
  m.policy.mockResolvedValue({ senderPolicyId: "5", receiverPolicyId: "5", canaryMaySend: true, canaryMayReceive: true });
  m.read.mockImplementation(async ({ functionName }: { functionName: string }) => (functionName === "policyId" ? 5n : true));
});

describe("pre-trade-gate on a Coinbase tokenized stock", () => {
  it("GO on a clean stock, without the launchpad-token checks", async () => {
    const r = (await preTradeGate({ address: NVDA, amountUsd: "1000" })) as Record<string, any>;
    expect(r.decision).toBe("GO");
    expect(r.assetType).toBe("tokenized-stock");
    expect(m.tokenRisk).not.toHaveBeenCalled();
    expect(r.receipt.context.join(" ")).toMatch(/market closed/);
    expect(r.receipt.context.join(" ")).toMatch(/seize/);
  });

  it("STOP when the buyer's wallet may not receive the stock", async () => {
    m.read.mockImplementation(async ({ functionName }: { functionName: string }) => (functionName === "policyId" ? 5n : functionName === "policyExists" ? true : false));
    const r = (await preTradeGate({ address: NVDA, wallet: WALLET })) as Record<string, any>;
    expect(r.decision).toBe("STOP");
    expect(r.receipt.checks.wallet.mayReceive).toBe(false);
    expect(r.enforce.available).toBe(false);
  });

  it("STOP when transfers are paused, or there is no pool", async () => {
    m.fv.mockResolvedValueOnce({ verdict: "fair", premiumBps: 0, pausedFeatures: ["transfer"] });
    expect(((await preTradeGate({ address: NVDA })) as Record<string, any>).decision).toBe("STOP");
    m.fv.mockResolvedValueOnce({ verdict: "not_trading", premiumBps: null, pausedFeatures: [] });
    expect(((await preTradeGate({ address: NVDA })) as Record<string, any>).decision).toBe("STOP");
  });

  it("HOLD on a wide premium, a stale reference or a tightened policy", async () => {
    m.fv.mockResolvedValueOnce({ verdict: "wide", premiumBps: 260, pausedFeatures: [], referenceStale: false });
    expect(((await preTradeGate({ address: NVDA })) as Record<string, any>).decision).toBe("HOLD");
    m.fv.mockResolvedValueOnce({ verdict: "fair", premiumBps: 5, pausedFeatures: [], referenceStale: true });
    expect(((await preTradeGate({ address: NVDA })) as Record<string, any>).decision).toBe("HOLD");
    m.policy.mockResolvedValueOnce({ senderPolicyId: "5", receiverPolicyId: "5", canaryMaySend: false, canaryMayReceive: true });
    expect(((await preTradeGate({ address: NVDA })) as Record<string, any>).decision).toBe("HOLD");
  });

  it("an unreadable check is HOLD + degraded, never GO", async () => {
    m.fv.mockRejectedValueOnce(new Error("dex down"));
    const r = (await preTradeGate({ address: NVDA })) as Record<string, any>;
    expect(r.decision).toBe("HOLD");
    expect(r.unverifiedChecks).toContain("stock-fair-value");
  });

  it("rejects a malformed wallet", async () => {
    await expect(preTradeGate({ address: NVDA, wallet: "0x12" })).rejects.toThrow(/wallet/);
  });
});
