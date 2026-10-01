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
import { classifyScheduledMultiplier, describeScheduledMultiplier, scheduleTransition } from "@/lib/tokenized-stocks";

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

  it("effectiveAt exactly equal to now is already effective, not pending (the <= boundary)", () => {
    expect(classifyScheduledMultiplier(2n * WAD, BigInt(NOW), WAD, NOW)).toBe("none");
  });

  it("a future change is scheduled even when the current multiplier could not be read", () => {
    // current=null must NOT be swallowed as a no-op: the conjunct `current !== null`
    // is load-bearing, or an unreadable current would hide a real scheduled split.
    expect(classifyScheduledMultiplier(2n * WAD, FUTURE, null, NOW)).toBe("scheduled");
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

describe("schedule transition (applied vs cancelled)", () => {
  // Fingerprints are `${pending}@${effectiveAt}` (decimal) or "none".
  const future = `${2n * WAD}@${NOW + 86_400}`;
  const past = `${2n * WAD}@${NOW - 86_400}`;

  it("an identical fingerprint is unchanged", () => {
    expect(scheduleTransition(future, future, WAD.toString(), NOW)).toBe("unchanged");
  });

  it("a fingerprint that now points at a future change is newly scheduled", () => {
    expect(scheduleTransition("none", future, WAD.toString(), NOW)).toBe("scheduled");
  });

  it("a future schedule removed BEFORE its effective time is cancelled", () => {
    expect(scheduleTransition(future, "none", WAD.toString(), NOW)).toBe("cancelled");
  });

  it("the bug it guards: a schedule cleared AT/AFTER its time is applied, never a false cancel", () => {
    // effectiveAt has passed and this read beat the on-chain move (multiplier
    // still old) — must be "applied", not "cancelled".
    expect(scheduleTransition(past, "none", WAD.toString(), NOW)).toBe("applied");
  });

  it("a schedule whose pending value the multiplier has reached is applied", () => {
    expect(scheduleTransition(future, "none", (2n * WAD).toString(), NOW)).toBe("applied");
  });
});
