import { describe, it, expect } from "vitest";
import { fxConvert, businessDays, inflationAdjust, isWeekend } from "@/lib/reference";

/** The handler returns one of two shapes (add-mode or count-mode); a test reads both. */
type Days = {
  resultDate?: string;
  businessDays?: number;
  skipped: Array<{ date: string; reason: string; name?: string }>;
  regionalHolidaysIgnored: unknown[];
};
const days = async (p: Record<string, string>) => (await businessDays(p)) as Days;

describe("fxConvert", () => {
  it("rejects what it cannot convert, before spending a request", async () => {
    await expect(fxConvert({ to: "EUR" })).rejects.toThrow(/'from'/);
    await expect(fxConvert({ from: "USD" })).rejects.toThrow(/'to'/);
    await expect(fxConvert({ from: "DOLLAR", to: "EUR" })).rejects.toThrow(/'from'/);
    await expect(fxConvert({ from: "USD", to: "EUR", amount: "abc" })).rejects.toThrow(/number/);
    await expect(fxConvert({ from: "USD", to: "EUR", date: "24-07-2026" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("converts and reports the per-unit rate", async () => {
    const r = await fxConvert({ from: "USD", to: "EUR", amount: "100" });
    expect(r.converted.EUR).toBeGreaterThan(0);
    expect(r.rate.EUR).toBeCloseTo(r.converted.EUR / 100, 6);
    expect(r.rateDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 30_000);

  /**
   * The ECB publishes on business days. Ask for a Sunday and the source answers
   * with Friday's rate and its own date — silently, unless we say so. An agent
   * booking a Sunday invoice at Friday's rate should know that is what happened.
   */
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
});

describe("isWeekend", () => {
  it("uses Saturday and Sunday by default", () => {
    expect(isWeekend("2026-08-01", "DE")).toBe(true); // Saturday
    expect(isWeekend("2026-08-03", "DE")).toBe(false); // Monday
  });

  it("knows the countries whose weekend is Friday and Saturday", () => {
    expect(isWeekend("2026-07-31", "AE")).toBe(true); // Friday
    expect(isWeekend("2026-08-02", "AE")).toBe(false); // Sunday is a working day
    expect(isWeekend("2026-08-02", "DE")).toBe(true);
  });
});

describe("businessDays", () => {
  it("insists on knowing what to compute", async () => {
    await expect(businessDays({ country: "TR" })).rejects.toThrow(/'add'.*'to'/);
    await expect(businessDays({ country: "Türkiye", add: "5" })).rejects.toThrow(/2-letter/);
    await expect(businessDays({ country: "TR", from: "01.08.2026", add: "5" })).rejects.toThrow(/YYYY-MM-DD/);
  });

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

describe("inflationAdjust", () => {
  it("rejects a year it cannot use", async () => {
    await expect(inflationAdjust({ amount: "100" })).rejects.toThrow(/'from'/);
    await expect(inflationAdjust({ amount: "100", from: "1899" })).rejects.toThrow(/'from'/);
    await expect(inflationAdjust({ amount: "abc", from: "2015" })).rejects.toThrow(/number/);
  });

  it("adjusts an amount and shows the index values behind it", async () => {
    const r = await inflationAdjust({ amount: "100", from: "2010", to: "2020", country: "US" });
    expect(r.toYear).toBe(2020);
    expect(r.adjusted).toBeGreaterThan(100);
    expect(r.factor).toBeCloseTo(r.indexTo / r.indexFrom, 5);
    expect(r.cumulativeInflationPct).toBeGreaterThan(0);
  }, 30_000);

  /**
   * The series is annual and published late. Asking for the current year must
   * not silently answer with an older one — the response says which year it used.
   */
  it("falls back to the newest published year, and says so", async () => {
    const r = await inflationAdjust({ amount: "100", from: "2015", to: "2100", country: "US" });
    expect(r.requestedToYear).toBe(2100);
    expect(r.toYear).toBeLessThan(2100);
    expect(r.usedLatestAvailable).toBe(true);
    expect(r.guidance).toMatch(/most recent published year/i);
  }, 30_000);
});
