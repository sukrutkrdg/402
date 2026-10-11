import { describe, expect, it } from "vitest";
import { preTradeBundle } from "@/lib/pre-trade-bundle";

describe("pre-trade-bundle", () => {
  it("rejects invalid addresses", async () => {
    await expect(preTradeBundle({ address: "invalid-token" })).rejects.toThrow(
      "Provide a valid 0x… Base token address"
    );
  });

  it("evaluates a standard token (e.g. DEGEN) and returns full composite check", async () => {
    const degen = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
    const res = await preTradeBundle({ address: degen });

    expect(res).toBeDefined();
    expect(res.address).toBe(degen.toLowerCase());
    expect(["SAFE_TO_TRADE", "ILLIQUID_SPREAD", "HIGH_RISK", "BLOCKED_HONEYPOT", "IMPERSONATOR_CLONE"]).toContain(
      res.verdict
    );
    expect(["EXECUTE", "REDUCE_SIZE", "ABORT"]).toContain(res.recommendation);
    expect(res.safetyScore).toBeGreaterThanOrEqual(0);
    expect(res.safetyScore).toBeLessThanOrEqual(100);
    expect(res.keyFindings.length).toBeGreaterThan(0);
    expect(res.checks).toBeDefined();
    expect(res.checks.clanker).toBeDefined();
    expect(res.checks.security).toBeDefined();
    expect(res.checks.liquidity).toBeDefined();
    expect(res.receipt).toBeDefined();
  }, 15000);
});
