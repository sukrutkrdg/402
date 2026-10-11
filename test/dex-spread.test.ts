import { describe, expect, it } from "vitest";
import { baseDexSpread, dexSpread } from "@/lib/dex-spread";

describe("base-dex-spread", () => {
  it("rejects invalid token addresses", async () => {
    await expect(baseDexSpread({ token: "not-an-address" })).rejects.toThrow(
      "Provide a valid 0x… Base token address"
    );
  });

  it("exports dexSpread alias identically", () => {
    expect(dexSpread).toBe(baseDexSpread);
  });

  it("calculates or safely handles DEX spread for DEGEN", async () => {
    const degen = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
    const res = await baseDexSpread({ token: degen });

    expect(res).toBeDefined();
    expect(res.tokenAddress).toBe(degen.toLowerCase());
    expect(["PROFITABLE_SPREAD", "TIGHT_NO_ARB", "SINGLE_DEX_ONLY", "NO_POOLS_FOUND"]).toContain(res.verdict);
    expect(typeof res.spreadBps).toBe("number");
    expect(res.data).toBeDefined();
    expect(res.receipt).toBeDefined();
  });
});
