/**
 * Cobalt's ERC-8056 scheduled-multiplier read, and the ways a naive version
 * would manufacture a corporate action that is not actually queued.
 *
 * The watcher deferred this until a schedule became readable (newUIMultiplier /
 * effectiveAt). The risk now is the opposite of the seize file's: there, the
 * danger was calling a seizable holder safe; here, it is calling nothing a
 * scheduled split — paging on a zeroed slot, a stale past schedule, or a no-op.
 * So "scheduled" is asserted only when the time is set, still in the future, and
 * the pending value genuinely differs from the current one.
 */

import { describe, it, expect } from "vitest";
import { classifyScheduledMultiplier, describeScheduledMultiplier } from "@/lib/tokenized-stocks";

const WAD = 10n ** 18n;
const NOW = 1_800_000_000; // a fixed wall clock for the tests
const FUTURE = BigInt(NOW + 86_400);
const PAST = BigInt(NOW - 86_400);

describe("ERC-8056 scheduled multiplier classification", () => {
  it("reverting selectors (pre-Cobalt / non-Asset) read as unknown, never scheduled", () => {
    // effectiveAt leg failed → we cannot say anything; must not alert.
    expect(classifyScheduledMultiplier(null, null, WAD, NOW)).toBe("unknown");
    expect(classifyScheduledMultiplier(2n * WAD, null, WAD, NOW)).toBe("unknown");
  });

  it("an unset effectiveAt slot means nothing is queued", () => {
    expect(classifyScheduledMultiplier(0n, 0n, WAD, NOW)).toBe("none");
    expect(classifyScheduledMultiplier(2n * WAD, 0n, WAD, NOW)).toBe("none");
  });

  it("a schedule already in the past is not pending — the multiplier watch owns it", () => {
    expect(classifyScheduledMultiplier(2n * WAD, PAST, WAD, NOW)).toBe("none");
  });

  it("a future effectiveAt with a value we could not read is unknown, not scheduled", () => {
    expect(classifyScheduledMultiplier(null, FUTURE, WAD, NOW)).toBe("unknown");
  });

  it("a future no-op (pending equals current) is not a scheduled change", () => {
    expect(classifyScheduledMultiplier(WAD, FUTURE, WAD, NOW)).toBe("none");
  });

  it("a different value queued for a future time is scheduled", () => {
    expect(classifyScheduledMultiplier(2n * WAD, FUTURE, WAD, NOW)).toBe("scheduled");
  });

  it("describes only a genuinely scheduled change, and says when and what", () => {
    const desc = describeScheduledMultiplier(WAD.toString(), {
      pending: (2n * WAD).toString(),
      effectiveAt: NOW + 86_400,
      status: "scheduled",
    });
    expect(desc).toContain(new Date((NOW + 86_400) * 1000).toISOString());
    expect(desc).toMatch(/2×/); // 1.0 → 2.0 is a 2× split-shaped move
    expect(desc).toContain("cancelable");
  });

  it("returns null for anything not scheduled, so a caller cannot print a non-event", () => {
    expect(describeScheduledMultiplier(WAD.toString(), { pending: null, effectiveAt: null, status: "none" })).toBeNull();
    expect(describeScheduledMultiplier(WAD.toString(), { pending: null, effectiveAt: null, status: "unknown" })).toBeNull();
  });
});
