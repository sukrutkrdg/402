import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression for the shape-mismatch bug: portfolioScan must read riskScore /
// riskLevel from the top level and taxes from `security`.
const { walletPortfolioMock, tokenRiskMock } = vi.hoisted(() => ({
  walletPortfolioMock: vi.fn(),
  tokenRiskMock: vi.fn(),
}));
vi.mock("@/lib/alchemy", () => ({ walletPortfolio: walletPortfolioMock }));
vi.mock("@/lib/onchain", () => ({ tokenRisk: tokenRiskMock }));

import { portfolioScan } from "@/lib/portfolio-scan";

const WALLET = "0x2222222222222222222222222222222222222222";
const RISKY = "0x3333333333333333333333333333333333333333";

describe("portfolioScan — surfaces a high-risk holding", () => {
  beforeEach(() => {
    walletPortfolioMock.mockResolvedValue({
      address: WALLET,
      totalUsd: 5000,
      tokenCount: 1,
      holdings: [{ symbol: "RISK", address: RISKY, usdValue: 5000 }],
    });
  });

  it("flags a non-honeypot but high-risk token (riskLevel/riskScore read correctly)", async () => {
    tokenRiskMock.mockResolvedValue({
      riskScore: 80,
      riskLevel: "high",
      flags: ["not_verified", "mintable"],
      security: { isHoneypot: false, sellTaxPct: 30 },
    });
    const r = (await portfolioScan({ address: WALLET })) as {
      riskyCount: number;
      portfolioRisk: string;
      usdInRiskyTokens: number;
      holdings: Array<{ riskScore: number | null; riskLevel: string; sellTaxPct: number | null }>;
    };
    expect(r.holdings[0].riskScore).toBe(80);
    expect(r.holdings[0].riskLevel).toBe("high");
    expect(r.holdings[0].sellTaxPct).toBe(30);
    expect(r.riskyCount).toBe(1);
    expect(r.portfolioRisk).toBe("high");
    expect(r.usdInRiskyTokens).toBe(5000);
  });
});
