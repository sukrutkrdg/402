/**
 * The sandwich-exposure classifier. Exposure is driven by price impact (the
 * attacker's working room) and trade size vs pool depth. Pinned so a threshold
 * edit is a deliberate choice, not a silent drift.
 */

import { describe, it, expect } from "vitest";
import { sandwichExposure } from "@/lib/mev-guard";

describe("sandwich exposure", () => {
  it("a tiny trade in a deep pool is low", () => {
    expect(sandwichExposure(0.1, 100, 10_000_000)).toBe("low");
  });

  it("moderate impact OR a ~1% depth ratio is elevated", () => {
    expect(sandwichExposure(0.8, 100, 10_000_000)).toBe("elevated"); // impact term
    expect(sandwichExposure(0.1, 200_000, 10_000_000)).toBe("elevated"); // depth ratio 2%
  });

  it("high impact OR a ~5%+ depth ratio is high", () => {
    expect(sandwichExposure(3, 100, 10_000_000)).toBe("high"); // impact term
    expect(sandwichExposure(0.1, 600_000, 10_000_000)).toBe("high"); // depth ratio 6%
  });

  it("a zero-liquidity pool is infinite depth ratio → high", () => {
    expect(sandwichExposure(0, 1000, 0)).toBe("high");
  });
});
