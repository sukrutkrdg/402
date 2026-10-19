import { describe, expect, it } from "vitest";
import { impermanentLossCalculator } from "../src/lib/impermanent-loss";

describe("impermanent-loss", () => {
  it("calculates correct impermanent loss for a 2x price shift", async () => {
    // Current price is double the initial price
    const result = await impermanentLossCalculator({
      initial_ratio: "100",
      current_ratio: "200"
    });

    // 2x shift = roughly 5.72% loss
    expect(result.initial_ratio).toBe(100);
    expect(result.current_ratio).toBe(200);
    expect(result.price_change_factor).toBe("2.0000");
    expect(result.impermanent_loss_pct).toBe("-5.72%");
    expect(result.advice).toContain("Significant impermanent loss detected");
  });

  it("calculates 0 IL when price ratio hasn't changed", async () => {
    const result = await impermanentLossCalculator({
      initial_ratio: "150",
      current_ratio: "150"
    });

    expect(result.impermanent_loss_pct).toBe("0.00%");
    expect(result.advice).toContain("Negligible impermanent loss");
  });

  it("throws error if parameters are missing", async () => {
    await expect(impermanentLossCalculator({})).rejects.toThrow("Missing initial_ratio or current_ratio");
  });
});
