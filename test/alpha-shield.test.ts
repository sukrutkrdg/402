import { describe, expect, it, vi } from "vitest";
import { preTradeAlphaShield } from "@/lib/alpha-shield";

// Mock internal dependencies for deterministic isolated unit testing
vi.mock("@/lib/onchain", () => ({
  tokenRisk: vi.fn(async () => ({
    security: { isHoneypot: false, buyTaxPct: 0, sellTaxPct: 0 },
    riskScore: 10,
    sources: ["goplus"],
  })),
}));

vi.mock("@/lib/sellability", () => ({
  sellability: vi.fn(async () => ({
    canSell: true,
    sellTaxPct: 0,
    simulated: true,
  })),
}));

vi.mock("@/lib/b20-safety", () => ({
  b20Safety: vi.fn(async () => ({
    isB20: false,
    canSeize: false,
    burnBlocked: false,
    hasPolicyRegistry: false,
  })),
}));

vi.mock("@/lib/owner-powers", () => ({
  ownerPowers: vi.fn(async () => ({
    powers: [],
    renounced: true,
  })),
}));

vi.mock("@/lib/swap-route", () => ({
  swapRoute: vi.fn(async () => ({
    estPriceImpactPct: 0.25,
    minAmountOut: "990",
  })),
}));

describe("pre-trade-alpha-shield", () => {
  it("rejects invalid addresses cleanly", async () => {
    await expect(preTradeAlphaShield({ address: "invalid" })).rejects.toThrow(
      "Provide a valid 0x… token contract address"
    );
  });

  it("returns EXECUTE with high safety score for clean tokens", async () => {
    const res = await preTradeAlphaShield({
      address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed",
      size: "1000",
    });

    expect(res).toBeDefined();
    expect(res.verdict).toBe("EXECUTE");
    expect(res.safetyScore).toBeGreaterThanOrEqual(90);
    expect(res.data.flags.isHoneypot).toBe(false);
    expect(res.data.recommendations.sandwichRisk).toBe("LOW");
    expect(res.data.recommendations.maxSafeTradeUsd).toBeGreaterThan(0);
  });

  it("flags honeypot tokens and returns ABORT", async () => {
    const { tokenRisk } = await import("@/lib/onchain");
    vi.mocked(tokenRisk).mockResolvedValueOnce({
      security: { isHoneypot: true, buyTaxPct: 99, sellTaxPct: 99 },
      riskScore: 99,
    } as any);

    const res = await preTradeAlphaShield({
      address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed",
    });

    expect(res.verdict).toBe("ABORT");
    expect(res.safetyScore).toBe(0);
    expect(res.data.flags.isHoneypot).toBe(true);
    expect(res.data.recommendations.maxSafeTradeUsd).toBe(0);
  });
});
