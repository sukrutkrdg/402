import { describe, it, expect } from "vitest";
import { impactPct } from "@/lib/liquidity";

describe("impactPct (constant-product price impact)", () => {
  it("is 50% when trade size equals the reserve", () => {
    expect(impactPct(1000, 1000)).toBe(50);
  });

  it("is 100% against a zero reserve (no liquidity)", () => {
    expect(impactPct(1000, 0)).toBe(100);
  });

  it("approaches 0% as the reserve dwarfs the trade", () => {
    expect(impactPct(1, 1_000_000)).toBeLessThan(0.01);
  });

  it("is monotonic: deeper reserves give lower impact for a fixed size", () => {
    expect(impactPct(1000, 100_000)).toBeLessThan(impactPct(1000, 10_000));
  });
});
