import { describe, it, expect } from "vitest";
import { toPreview } from "@/lib/preview";

describe("toPreview (free-tier teaser)", () => {
  it("keeps headline scalars, counts arrays, hides prose and nested detail", () => {
    const full = {
      address: "0xabc",
      symbol: "FOO",
      rugScore: 72,
      level: "high",
      canSell: false,
      signals: ["a", "b", "c"],
      flags: ["mintable"],
      recommendation: "Avoid — high rug probability.",
      summary: "Long synthesized summary…",
      note: "Not financial advice.",
      bestPool: { dex: "uniswap", liquidityUsd: 1000 },
    };
    const p = toPreview(full);

    // Headline scalars survive.
    expect(p.rugScore).toBe(72);
    expect(p.level).toBe("high");
    expect(p.symbol).toBe("FOO");
    expect(p.canSell).toBe(false);

    // Arrays become counts (reveal how many, hide what).
    expect(p.signalsCount).toBe(3);
    expect(p.flagsCount).toBe(1);
    expect(p.signals).toBeUndefined();
    expect(p.flags).toBeUndefined();

    // Prose and nested detail are locked away.
    expect(p.recommendation).toBeUndefined();
    expect(p.summary).toBeUndefined();
    expect(p.note).toBeUndefined();
    expect(p.bestPool).toBeUndefined();
  });

  it("returns an empty object for non-object input", () => {
    expect(toPreview(null)).toEqual({});
    expect(toPreview("x")).toEqual({});
  });
});
