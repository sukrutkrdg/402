import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A holiday calendar with a hole in it answers like one without.
 *
 * The year set was built from the start year and a GUESSED end year, each
 * expanded by ±1. So "from 2020-01-01 to 2026-01-01" loaded 2019-2021 and
 * 2025-2027 and had no data at all for 2022, 2023 and 2024 — every national
 * holiday in that gap silently counted as a working day. The response carried
 * nothing that could reveal it: same shape, same confident number, just wrong
 * for any span over about two years. Which is most of what a "net 30 business
 * days" endpoint gets asked.
 *
 * Years are now loaded for the days actually walked, and the response lists
 * which ones, so coverage is checkable instead of assumed.
 */
const fetchMock = vi.fn();

/** One national holiday per year, mid-year, for every year queried. */
const holidayFor = (y: number) => `${y}-07-15`;

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const [, year] = String(url).match(/PublicHolidays\/(\d{4})\//) ?? [];
    const y = Number(year);
    return {
      ok: true,
      status: 200,
      json: async () => [{ date: holidayFor(y), name: `Holiday ${y}`, global: true, counties: null }],
    };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const yearsRequested = () =>
  fetchMock.mock.calls
    .map((c) => Number(String(c[0]).match(/PublicHolidays\/(\d{4})\//)?.[1]))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

describe("businessDays covers every year the range touches", () => {
  it("loads the middle years of a multi-year span", async () => {
    const { businessDays } = await import("@/lib/reference");
    const res = (await businessDays({ country: "TR", from: "2020-01-01", to: "2026-01-01" })) as Record<string, unknown>;

    const years = yearsRequested();
    for (const y of [2020, 2021, 2022, 2023, 2024, 2025]) {
      expect(years, `${y} was never fetched — its holidays would count as working days`).toContain(y);
    }
    expect(res.holidayYearsCovered).toEqual(expect.arrayContaining([2020, 2021, 2022, 2023, 2024, 2025]));
  });

  it("has the middle years' holidays in the calendar it counts against", async () => {
    // `skipped` is capped at 60 entries and weekends fill it long before 2022,
    // so the observable proof is the calendar the walk consults: one holiday per
    // year for every year in the span, none missing.
    const { businessDays } = await import("@/lib/reference");
    const res = (await businessDays({ country: "TR", from: "2020-01-01", to: "2026-01-01" })) as {
      nationalHolidaysConsidered: number;
      holidayYearsCovered: number[];
    };
    expect(res.holidayYearsCovered).toEqual([2020, 2021, 2022, 2023, 2024, 2025, 2026]);
    expect(res.nationalHolidaysConsidered, "one per covered year, no gap").toBe(7);
  });

  it("does not fetch years the range never reaches", async () => {
    const { businessDays } = await import("@/lib/reference");
    await businessDays({ country: "TR", from: "2026-03-02", to: "2026-03-06" });
    expect(yearsRequested()).toEqual([2026]);
  });

  it("walks only as far as `add` actually needs, instead of guessing an end", async () => {
    const { businessDays } = await import("@/lib/reference");
    const res = (await businessDays({ country: "TR", from: "2026-03-02", add: "10" })) as Record<string, unknown>;
    expect(res.resultDate).toBe("2026-03-16"); // 10 business days, no holidays in range
    expect(yearsRequested()).toEqual([2026]);
  });

  it("refuses a span too wide to cover instead of covering part of it", async () => {
    const { businessDays } = await import("@/lib/reference");
    await expect(businessDays({ country: "TR", from: "2000-01-01", to: "2090-01-01" })).rejects.toThrow(/spans more than/i);
  });

  it("refuses dates outside the supported calendar range", async () => {
    const { businessDays } = await import("@/lib/reference");
    await expect(businessDays({ country: "TR", from: "1970-01-01", to: "1971-01-01" })).rejects.toThrow(/1975/);
  });

  it("still reports an unsupported country rather than an empty calendar", async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => [] }));
    const { businessDays } = await import("@/lib/reference");
    await expect(businessDays({ country: "ZZ", from: "2026-01-01", add: "5" })).rejects.toThrow(/No holiday calendar/i);
  });
});
