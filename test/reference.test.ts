import { describe, it, expect } from "vitest";
import { fxConvert, businessDays, inflationAdjust, isWeekend } from "@/lib/reference";

/**
 * The hermetic half of the reference services.
 *
 * Everything here either is a pure function or rejects before `reference.ts`
 * reaches for the network. The half that actually calls the ECB, the holiday
 * calendar and the World Bank lives in `reference-live.test.ts`, behind
 * `LIVE=1`.
 *
 * The split was forced by the tests failing twice in one day — `inflationAdjust`
 * on 2026-09-08 and `businessDays` on 2026-09-09 — each time under the parallel
 * suite and each time passing on its own. Nothing was wrong with the code: three
 * third-party APIs were being called by the build, so a slow upstream failed it.
 * A suite that goes red for reasons the commit cannot cause is a suite people
 * stop reading, which is how the real breakage gets through.
 *
 * The live assertions are worth keeping — one of them pins a genuine bug, where
 * the ECB writes its XML attributes in single quotes and a double-quote-only
 * pattern sent every call to the mirror while the code claimed otherwise — so
 * they are moved, not deleted.
 */

describe("fxConvert refuses before it spends a request", () => {
  it("names the missing or malformed argument", async () => {
    await expect(fxConvert({ to: "EUR" })).rejects.toThrow(/'from'/);
    await expect(fxConvert({ from: "USD" })).rejects.toThrow(/'to'/);
    await expect(fxConvert({ from: "DOLLAR", to: "EUR" })).rejects.toThrow(/'from'/);
    await expect(fxConvert({ from: "USD", to: "EUR", amount: "abc" })).rejects.toThrow(/number/);
    await expect(fxConvert({ from: "USD", to: "EUR", date: "24-07-2026" })).rejects.toThrow(/YYYY-MM-DD/);
  });
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

describe("businessDays refuses before it spends a request", () => {
  it("insists on knowing what to compute", async () => {
    await expect(businessDays({ country: "TR" })).rejects.toThrow(/'add'.*'to'/);
    await expect(businessDays({ country: "Türkiye", add: "5" })).rejects.toThrow(/2-letter/);
    await expect(businessDays({ country: "TR", from: "01.08.2026", add: "5" })).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe("inflationAdjust refuses before it spends a request", () => {
  it("rejects a year it cannot use", async () => {
    await expect(inflationAdjust({ amount: "100" })).rejects.toThrow(/'from'/);
    await expect(inflationAdjust({ amount: "100", from: "1899" })).rejects.toThrow(/'from'/);
    await expect(inflationAdjust({ amount: "abc", from: "2015" })).rejects.toThrow(/number/);
  });
});
