import { describe, it, expect } from "vitest";
import { ibanCheck } from "@/lib/iban";

/**
 * The first endpoint written from the traction data rather than from what was
 * interesting to build.
 *
 * Measured 2026-08-21: 116 of 132 indexed resources saw no outside caller in 30
 * days, and the 16 that did average 1.6 calls per payer. Everything we sell
 * answers a question once. An IBAN check is called once per payout row, which is
 * the property the catalogue is missing — so the tests care most about the cases
 * a batch of real supplier rows would actually contain.
 */
const VALID = [
  ["GB82WEST12345698765432", "GB", "United Kingdom", true],
  ["DE89370400440532013000", "DE", "Germany", true],
  ["FR1420041010050500013M02606", "FR", "France", true],
  ["TR330006100519786457841326", "TR", "Türkiye", false],
  ["NL91ABNA0417164300", "NL", "Netherlands", true],
  ["MT84MALT011000012345MTLCAST001S", "MT", "Malta", true],
  ["NO9386011117947", "NO", "Norway", true],
] as const;

describe("valid IBANs across the length range", () => {
  it.each(VALID)("accepts %s", (iban, cc, name, sepa) => {
    const r = ibanCheck({ iban });
    expect(r.valid, r.reason ?? "").toBe(true);
    expect(r.country).toBe(cc);
    expect(r.countryName).toBe(name);
    expect(r.sepa).toBe(sepa);
    expect(r.reason).toBeNull();
  });

  it("handles the shortest (Norway, 15) and longest (Malta, 31) in the table", () => {
    expect(ibanCheck({ iban: "NO9386011117947" }).valid).toBe(true);
    expect(ibanCheck({ iban: "MT84MALT011000012345MTLCAST001S" }).valid).toBe(true);
  });
});

describe("the input a spreadsheet actually produces", () => {
  it("accepts the printed grouping, and gives it back", () => {
    const r = ibanCheck({ iban: "GB82 WEST 1234 5698 7654 32" });
    expect(r.valid).toBe(true);
    expect(r.formatted, "callers render this straight into a UI").toBe("GB82 WEST 1234 5698 7654 32");
    expect(r.iban, "and machines want it unspaced").toBe("GB82WEST12345698765432");
  });

  it("accepts lowercase and hyphens", () => {
    expect(ibanCheck({ iban: "de89-3704-0044-0532-0130-00" }).valid).toBe(true);
    expect(ibanCheck({ iban: "nl91abna0417164300" }).valid).toBe(true);
  });
});

describe("rejections say which of the three checks failed", () => {
  // "Invalid" alone does not tell a caller whether to fix the row or drop it.
  it("catches a single transposed pair — the error this exists for", () => {
    const r = ibanCheck({ iban: "GB82WEST12345698675432" }); // 76 -> 67
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/checksum failed/i);
    expect(r.countryName, "still tells you where it was meant to be").toBe("United Kingdom");
  });

  it("catches a dropped character as a length error, not a checksum one", () => {
    const r = ibanCheck({ iban: "DE8937040044053201300" });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/22 characters; this one is 21/);
    expect(r.expectedLength).toBe(22);
  });

  it("catches the classic O-for-zero", () => {
    const r = ibanCheck({ iban: "NL91ABNA04171643OO" });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/checksum failed/i);
  });

  it("names an unregistered country instead of guessing a length", () => {
    const r = ibanCheck({ iban: "ZZ8237040044053201300000" });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/No IBAN country registered for 'ZZ'/);
    expect(r.expectedLength).toBeNull();
  });

  it("rejects punctuation and empty input distinctly", () => {
    expect(ibanCheck({ iban: "GB82WEST1234$698765432" }).reason).toMatch(/not letters or digits/i);
    expect(() => ibanCheck({ iban: "   " })).toThrow(/Provide an IBAN/);
  });
});

describe("mod-97 is exact past the float limit", () => {
  it("a 31-character IBAN expands past 2^53 and still validates", () => {
    // MT is 31 chars; letters expand to two digits each, so the integer is ~60
    // digits. A naive Number() would silently lose precision and pass garbage.
    const r = ibanCheck({ iban: "MT84MALT011000012345MTLCAST001S" });
    expect(r.valid).toBe(true);
    // And a one-character change in the tail must still be caught at that size.
    expect(ibanCheck({ iban: "MT84MALT011000012345MTLCAST001T" }).valid).toBe(false);
  });
});

describe("what it does not claim", () => {
  it("says in the response that structural validity is not account existence", () => {
    // The one way this endpoint could do real harm is by being read as
    // "safe to pay". It has to say otherwise in the payload, not just the docs.
    const r = ibanCheck({ iban: "DE89370400440532013000" });
    expect(r.note).toMatch(/does NOT prove the account exists/i);
    expect(r.note).toMatch(/no offline check can/i);
  });

  it("extracts the bank identifier where the layout is known, and null where it is not", () => {
    expect(ibanCheck({ iban: "DE89370400440532013000" }).bankIdentifier).toBe("37040044");
    expect(ibanCheck({ iban: "GB82WEST12345698765432" }).bankIdentifier).toBe("WEST");
    // Vatican has no bank slice in the table; null beats a wrong substring.
    const va = ibanCheck({ iban: "VA59001123000012345678" });
    expect(va.valid).toBe(true);
    expect(va.bankIdentifier).toBeNull();
  });
});
