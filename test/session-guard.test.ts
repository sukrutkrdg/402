import { describe, expect, it } from "vitest";
import { agentSessionGuard } from "@/lib/session-guard";

describe("agent-session-guard", () => {
  it("rejects invalid signer addresses", async () => {
    await expect(agentSessionGuard({ signer: "bad-signer" })).rejects.toThrow(
      "Provide a valid 0x… agent session signer address"
    );
  });

  it("flags wildcard, perpetual, and uncapped session keys as HIGH_RISK_DRAINABLE", async () => {
    const signer = "0x973a31858f4d2125f48c880542da11a2796f12d6";
    const res = await agentSessionGuard({ signer });

    expect(res).toBeDefined();
    expect(res.signer).toBe(signer.toLowerCase());
    expect(res.verdict).toBe("HIGH_RISK_DRAINABLE");
    expect(res.isWildcardTarget).toBe(true);
    expect(res.isPerpetualSession).toBe(true);
    expect(res.isUncappedSpending).toBe(true);
    expect(res.securityScore).toBeLessThan(50);
    expect(res.data.risks.length).toBeGreaterThan(0);
    expect(res.receipt).toBeDefined();
  });

  it("evaluates a strictly guarded session key as SECURE_GUARDED", async () => {
    const signer = "0x973a31858f4d2125f48c880542da11a2796f12d6";
    const aerodromeRouter = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
    const res = await agentSessionGuard({
      signer,
      allowedTargets: aerodromeRouter,
      spendCapUsd: "50",
      expiryHours: "12",
    });

    expect(res).toBeDefined();
    expect(res.verdict).toBe("SECURE_GUARDED");
    expect(res.isWildcardTarget).toBe(false);
    expect(res.isPerpetualSession).toBe(false);
    expect(res.isUncappedSpending).toBe(false);
    expect(res.securityScore).toBeGreaterThanOrEqual(80);
    expect(res.data.positives.length).toBeGreaterThan(0);
  });
});
