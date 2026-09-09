import { describe, it, expect } from "vitest";
import { fxConvert, businessDays, inflationAdjust } from "@/lib/reference";

/**
 * The reference services against their real upstreams — OFF by default,
 * `LIVE=1` turns it on.
 *
 *   LIVE=1 npx vitest run test/reference-live.test.ts
 *
 * These three handlers call the ECB's daily reference rates, a public holiday
 * calendar and the World Bank's inflation series. That makes the assertions
 * below the only place we check our reading of those formats — and it also made
 * them unfit to gate a build. Run inside the parallel suite they failed twice in
 * one day (`inflationAdjust` on 2026-09-08, `businessDays` on 2026-09-09) and
 * passed in isolation both times, because a third-party API was slow, not
 * because anything here changed. A suite that reddens for reasons no commit can
 * cause stops being read, and then the real failure goes through with it.
 *
 * They are gated rather than deleted because each one pins something that was
 * once wrong and would be silent if it broke again:
 *
 *   - The ECB writes its XML attributes in single quotes. A double-quote-only
 *     pattern matched nothing, so every call quietly used the third-party mirror
 *     while the code reported the ECB as its source — working, but not what it
 *     said.
 *   - The ECB publishes on business days only. Ask for a Sunday and it answers
 *     with Friday's rate under its own date; an agent booking a Sunday invoice
 *     needs to be told that is what happened.
 *   - Germany's Epiphany is regional. Treating it as national would move every
 *     German due date by a day, once a year, for the whole country.
 *   - The inflation series is annual and published late, so the current year is
 *     usually missing and must be reported as substituted rather than silently
 *     answered from an older one.
 *
 * Run these before shipping a change to `src/lib/reference.ts`, and when one of
 * those upstreams announces a format change. The daily `SMOKE=1` sweep already
 * calls the same handlers, so an upstream that breaks outright still surfaces
 * there; what only this file catches is a change in the SHAPE of a reply that
 * still returns 200.
 */

const RUN = process.env.LIVE === "1";

describe.skipIf(!RUN)("fxConvert against the ECB", () => {
  it("converts and reports the per-unit rate", async () => {
    const r = await fxConvert({ from: "USD", to: "EUR", amount: "100" });
    expect(r.converted.EUR).toBeGreaterThan(0);
    expect(r.rate.EUR).toBeCloseTo(r.converted.EUR / 100, 6);
    expect(r.rateDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 30_000);

  it("says when the rate is not from the date that was asked for", async () => {
    const r = await fxConvert({ from: "USD", to: "EUR", date: "2026-07-26" }); // a Sunday
    expect(r.requestedDate).toBe("2026-07-26");
    expect(r.rateDate).not.toBe("2026-07-26");
    expect(r.usedEarlierRate).toBe(true);
    expect(r.guidance).toMatch(/business days only/i);
  }, 30_000);

  it("handles several targets in one call", async () => {
    const r = await fxConvert({ from: "EUR", to: "USD,TRY,GBP" });
    expect(Object.keys(r.converted).sort()).toEqual(["GBP", "TRY", "USD"]);
  }, 30_000);

  it("reads the ECB's own file rather than falling through to the mirror", async () => {
    const r = await fxConvert({ from: "EUR", to: "USD" });
    expect(r.source).toMatch(/ecb\.europa\.eu/);
    expect(r.source).not.toMatch(/mirror/i);
  }, 30_000);
});

/** The handler returns one of two shapes (add-mode or count-mode); a test reads both. */
type Days = {
  resultDate?: string;
  businessDays?: number;
  skipped: Array<{ date: string; reason: string; name?: string }>;
  regionalHolidaysIgnored: unknown[];
};
const days = async (p: Record<string, string>) => (await businessDays(p)) as Days;

describe.skipIf(!RUN)("businessDays against the holiday calendar", () => {
  it("skips weekends when adding days", async () => {
    // Friday 2026-07-31 + 1 business day = Monday 2026-08-03
    const r = await days({ country: "DE", from: "2026-07-31", add: "1" });
    expect(r.resultDate).toBe("2026-08-03");
    expect(r.skipped.map((s) => s.reason)).toEqual(["weekend", "weekend"]);
  }, 30_000);

  it("skips a national holiday, and names it", async () => {
    // 2026-01-01 is a holiday in Germany; from Wed 2025-12-31 + 1 business day
    // lands on Friday 2026-01-02.
    const r = await days({ country: "DE", from: "2025-12-31", add: "1" });
    expect(r.resultDate).toBe("2026-01-02");
    expect(r.skipped.some((s) => s.reason === "public_holiday")).toBe(true);
  }, 30_000);

  it("counts business days between two dates, net-30 style", async () => {
    const r = await days({ country: "DE", from: "2026-08-03", to: "2026-08-10" });
    expect(r.businessDays).toBe(5); // Mon→Mon, one weekend in between
  }, 30_000);

  it("does not apply a province-only holiday to the whole country", async () => {
    const r = await days({ country: "DE", from: "2026-01-05", add: "1" });
    // 2026-01-06 (Epiphany) is regional in Germany, so it stays a business day.
    expect(r.resultDate).toBe("2026-01-06");
    expect(r.regionalHolidaysIgnored.length).toBeGreaterThan(0);
  }, 30_000);

  it("refuses a country it has no calendar for", async () => {
    await expect(businessDays({ country: "XX", from: "2026-08-03", add: "1" })).rejects.toThrow();
  }, 30_000);
});

describe.skipIf(!RUN)("inflationAdjust against the World Bank series", () => {
  it("adjusts an amount and shows the index values behind it", async () => {
    const r = await inflationAdjust({ amount: "100", from: "2010", to: "2020", country: "US" });
    expect(r.toYear).toBe(2020);
    expect(r.adjusted).toBeGreaterThan(100);
    expect(r.factor).toBeCloseTo(r.indexTo / r.indexFrom, 5);
    expect(r.cumulativeInflationPct).toBeGreaterThan(0);
  }, 30_000);

  it("falls back to the newest published year, and says so", async () => {
    const r = await inflationAdjust({ amount: "100", from: "2015", to: "2100", country: "US" });
    expect(r.requestedToYear).toBe(2100);
    expect(r.toYear).toBeLessThan(2100);
    expect(r.usedLatestAvailable).toBe(true);
    expect(r.guidance).toMatch(/most recent published year/i);
  }, 30_000);
});
