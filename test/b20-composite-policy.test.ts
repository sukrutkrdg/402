/**
 * Cobalt Composite Policies are a non-event for the verdict — isAuthorized()
 * resolves the whole UNION/INTERSECT tree on chain and never reverts, so every
 * GO/HOLD/STOP in b20-safety is already correct on a composite gate. What they
 * change is explanation, so the only thing worth unit-testing here is that we
 * describe a composite ONLY when one is actually present, and never assert
 * structure we could not read.
 */

import { describe, it, expect } from "vitest";
import { describeComposite } from "@/lib/b20-safety";

describe("B20 Cobalt composite policy description", () => {
  it("says nothing for a simple policy", () => {
    expect(describeComposite({ composite: false, childIds: [] })).toBeNull();
  });

  it("says nothing when the structure could not be read (null), never guesses simple", () => {
    expect(describeComposite(null)).toBeNull();
  });

  it("names the children and credits isAuthorized with resolving them", () => {
    const note = describeComposite({ composite: true, childIds: ["7", "9"] });
    expect(note).toContain("COMPOSITE of 2 child policies");
    expect(note).toContain("7, 9");
    expect(note).toContain("isAuthorized");
  });
});
