import { describe, it, expect } from "vitest";
import { deepestPool } from "@/lib/dex-pool";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const WETH = "0x4200000000000000000000000000000000000006";

// USDC is the quote side of its deep pools; its own base-side pairs are small.
const pairs = [
  { baseToken: { address: USDC }, quoteToken: { address: "0xaaa" }, priceUsd: "1.0001", liquidity: { usd: 140_000 } },
  { baseToken: { address: AERO }, quoteToken: { address: USDC }, priceUsd: "0.8955", priceNative: "0.8955", liquidity: { usd: 43_000_000 } },
  { baseToken: { address: WETH }, quoteToken: { address: USDC }, priceUsd: "2430", priceNative: "2430.5", liquidity: { usd: 9_000_000 } },
];

describe("deepestPool", () => {
  it("finds a quote-side token's deepest pool and prices it from the base", () => {
    const d = deepestPool(pairs, USDC)!;
    expect(d.side).toBe("quote");
    expect(d.liquidityUsd).toBe(43_000_000);
    expect(d.priceUsd).toBeCloseTo(1, 3);
    expect(d.poolCount).toBe(3);
    expect(d.totalLiquidityUsd).toBe(52_140_000);
  });

  it("never prices a quote-side token at its base's price", () => {
    // wallet-tokens once valued 3.78 USDC at ETH's price ($9,173).
    const only = [pairs[2]];
    expect(deepestPool(only, USDC)!.priceUsd).toBeCloseTo(2430 / 2430.5, 3);
  });

  it("reads the base side directly", () => {
    const d = deepestPool(pairs, AERO)!;
    expect(d.side).toBe("base");
    expect(d.priceUsd).toBe(0.8955);
  });

  it("is null for a token in no pool", () => {
    expect(deepestPool(pairs, "0x0000000000000000000000000000000000000001")).toBeNull();
  });
});
