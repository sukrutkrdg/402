/**
 * The peg classifier. The one false-negative that matters: an unreadable price
 * must be "unknown", never a healthy peg — a feed outage cannot read as $1.00.
 */

import { describe, it, expect } from "vitest";
import { classify } from "@/lib/stablecoin-peg";

describe("stablecoin peg classify", () => {
  it("an unreadable / non-positive price is unknown, never healthy", () => {
    expect(classify(null).status).toBe("unknown");
    expect(classify(0).status).toBe("unknown");
    expect(classify(-1).status).toBe("unknown");
    expect(classify(NaN).status).toBe("unknown");
  });

  it("within 0.5% of $1 is healthy", () => {
    expect(classify(1).status).toBe("healthy");
    expect(classify(1.004).status).toBe("healthy");
    expect(classify(0.996).status).toBe("healthy");
  });

  it("0.5%–2% off is watch, either side", () => {
    expect(classify(1.01).status).toBe("watch");
    expect(classify(0.99).status).toBe("watch");
  });

  it("2%+ off is a depeg, and the deviation sign points the right way", () => {
    expect(classify(0.97)).toEqual({ deviationBps: -300, status: "depeg" });
    expect(classify(1.03)).toEqual({ deviationBps: 300, status: "depeg" });
  });
});
