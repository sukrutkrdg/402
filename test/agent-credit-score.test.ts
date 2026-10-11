import { describe, expect, it, vi } from "vitest";
import { agentCreditScore } from "@/lib/agent-credit-score";

describe("agent-credit-score", () => {
  it("rejects non-0x addresses", async () => {
    await expect(agentCreditScore({ address: "not-an-address" })).rejects.toThrow(
      "Provide a valid 0x… agent wallet or contract address"
    );
  });

  it("evaluates a valid wallet address and returns credit tier and limits", async () => {
    // Uses Jesse Pollak / Base active wallet
    const address = "0x50ec051c512da5047b41e8c78c2e6ba804be8505";
    const res = await agentCreditScore({ address });

    expect(res).toBeDefined();
    expect(res.creditScore).toBeGreaterThanOrEqual(300);
    expect(res.creditScore).toBeLessThanOrEqual(850);
    expect(["AAA", "AA", "A", "B", "C", "F"]).toContain(res.ratingTier);
    expect(res.data.financingSpreadPct).toBe(2.5);
    expect(typeof res.data.postpaidCreditLimitUsd).toBe("number");
    expect(res.data.metrics).toBeDefined();
    expect(res.data.terms).toBeDefined();
  });
});
