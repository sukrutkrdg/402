import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression for the shape-mismatch bug: sellability must read honeypot/tax
// fields from tokenRisk()'s nested `security` object, not the top level.
const { tokenRiskMock, holderMock, exitMock } = vi.hoisted(() => ({
  tokenRiskMock: vi.fn(),
  holderMock: vi.fn(),
  exitMock: vi.fn(),
}));
vi.mock("@/lib/onchain", () => ({ tokenRisk: tokenRiskMock }));
vi.mock("@/lib/holders", () => ({ holderDistribution: holderMock }));
vi.mock("@/lib/liquidity", () => ({ exitLiquidity: exitMock }));

import { sellability } from "@/lib/sellability";

const TOKEN = "0x1111111111111111111111111111111111111111";

describe("sellability — reads tax from the nested security shape", () => {
  beforeEach(() => {
    holderMock.mockResolvedValue({ topHolders: [] }); // no holder → skip live sim
    exitMock.mockResolvedValue({ canExit: true });
  });

  it("fails a high-sell-tax token on the tax alone (not just honeypot)", async () => {
    tokenRiskMock.mockResolvedValue({
      flags: [],
      securityChecked: true,
      security: { isHoneypot: false, sellTaxPct: 90, buyTaxPct: 0, transferPausable: false },
    });
    const r = (await sellability({ address: TOKEN })) as {
      canSell: boolean;
      sellTaxPct: number | null;
      verdict: string;
    };
    expect(r.sellTaxPct).toBe(90);
    expect(r.canSell).toBe(false);
    expect(r.verdict).toBe("do_not_buy_cannot_sell");
  });

  it("reports a clean, low-tax token as sellable", async () => {
    tokenRiskMock.mockResolvedValue({
      flags: [],
      securityChecked: true,
      security: { isHoneypot: false, sellTaxPct: 0, buyTaxPct: 0, transferPausable: false },
    });
    const r = (await sellability({ address: TOKEN })) as { canSell: boolean; verdict: string };
    expect(r.canSell).toBe(true);
    expect(r.verdict).toBe("sellable");
  });

  it("does NOT report sellable when the security feed was unavailable", async () => {
    // GoPlus down: tokenRisk fulfills with no security data (securityChecked=false).
    // With no live sim either (no holder), sellability must degrade, never "sellable".
    tokenRiskMock.mockResolvedValue({ flags: [], securityChecked: false, security: undefined });
    const r = (await sellability({ address: TOKEN })) as { canSell: boolean | null; verdict: string; degraded?: boolean };
    expect(r.canSell).toBeNull();
    expect(r.verdict).toBe("unknown");
    expect(r.degraded).toBe(true);
  });
});
