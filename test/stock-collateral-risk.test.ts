import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/upstream-cache", () => ({ dexTokenPairs: vi.fn() }));
vi.mock("@/lib/stock-corporate-actions", () => ({ readStockActions: vi.fn(async () => []) }));

import { projectHealth, dropToLiquidation, riskBand, stockCollateralRisk } from "@/lib/stock-collateral-risk";

describe("stock collateral risk", () => {
  // Measured 2026-10-17: one AAPLc leg, HF 1.0513, oracle 343.665, DEX 342.99.
  it("re-prices a single leg by DEX ÷ oracle", () => {
    const p = projectHealth(1.0513, [{ valueUsd: 5.59, collateralFactor: 0.78, oraclePrice: 343.665, dexPrice: 342.99 }]);
    expect(p).toBeCloseTo(1.0513 * (342.99 / 343.665), 6);
  });

  it("weights legs by value × collateral factor; a leg with no DEX price keeps its oracle value", () => {
    const p = projectHealth(2, [
      { valueUsd: 100, collateralFactor: 0.5, oraclePrice: 10, dexPrice: 9 }, // weight 50, −10%
      { valueUsd: 100, collateralFactor: 0.5, oraclePrice: 10, dexPrice: null }, // weight 50, unchanged
    ]);
    expect(p).toBeCloseTo(2 * 0.95, 9);
  });

  it("no collateral → no projection", () => {
    expect(projectHealth(1.2, [])).toBeNull();
  });

  it("the move to liquidation", () => {
    expect(dropToLiquidation(1.25)).toBe(20);
    expect(dropToLiquidation(1.0513)).toBe(4.88);
    expect(dropToLiquidation(null)).toBeNull();
  });

  it("bands", () => {
    expect(riskBand(0.99, true)).toBe("liquidatable");
    expect(riskBand(1.04, true)).toBe("critical");
    expect(riskBand(1.1, true)).toBe("at_risk");
    expect(riskBand(1.3, true)).toBe("watch");
    expect(riskBand(2, true)).toBe("safe");
    expect(riskBand(null, false)).toBe("no_debt");
  });

  it("asks for a wallet", async () => {
    await expect(stockCollateralRisk({})).rejects.toThrow(/wallet/);
  });
});
