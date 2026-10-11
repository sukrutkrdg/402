import { describe, expect, it, vi } from "vitest";
import { agentFullAudit } from "@/lib/agent-full-audit";

vi.mock("@/lib/agent-provenance", () => ({
  agentProvenance: vi.fn(async () => ({
    data: {
      framework: "Coinbase AgentKit",
      isAutonomous: true,
      isDelegated: false,
      confidence: "HIGH",
    },
  })),
}));

vi.mock("@/lib/agent-credit-score", () => ({
  agentCreditScore: vi.fn(async () => ({
    data: {
      creditScore: 780,
      ratingTier: "AAA",
      postpaidCreditLimitUsd: 100,
      metrics: { activityTier: "HIGH_FREQUENCY" },
    },
  })),
}));

vi.mock("@/lib/onchain-forensics", () => ({
  washTrading: vi.fn(async () => ({
    data: {
      isWashTrading: false,
      confidence: "LOW",
    },
  })),
}));

describe("agent-full-audit", () => {
  it("rejects invalid addresses", async () => {
    await expect(agentFullAudit({ address: "invalid" })).rejects.toThrow(
      "Provide a valid 0x… agent address to audit"
    );
  });

  it("produces full audit with verified autonomous verdict for clean agents", async () => {
    const res = await agentFullAudit({ address: "0x50ec051c512da5047b41e8c78c2e6ba804be8505" });

    expect(res).toBeDefined();
    expect(res.verdict).toBe("VERIFIED_AUTONOMOUS");
    expect(res.trustScore).toBeGreaterThanOrEqual(70);
    expect(res.data.provenance.framework).toBe("Coinbase AgentKit");
    expect(res.data.financials.creditRating).toBe("AAA");
    expect(res.data.integrity.washTradingDetected).toBe(false);
  });
});
