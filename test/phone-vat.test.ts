import { describe, it, expect } from "vitest";
import { phoneCheck } from "@/lib/phone";
import { vatCheck } from "@/lib/vat";

/**
 * Two more per-row checks, written for the same reason as iban-check: the
 * catalogue's 16 endpoints with outside callers average 1.6 calls per payer
 * because they answer a question once. These are called once per record.
 *
 * Both have the same danger, and it is not being wrong — it is being read as
 * answering the bigger question. "Structurally valid phone number" is not
 * "reachable", and "structurally valid VAT number" is certainly not "registered
 * and safe to zero-rate an invoice against". The tests below spend as much
 * effort on that boundary as on the arithmetic.
 */
describe("phoneCheck — normalisation", () => {
  it("normalises the ways a human writes the same number", () => {
    for (const input of ["+90 532 123 45 67", "+905321234567", "0090-532-123-45-67", "+90 (532) 123 4567"]) {
      const r = phoneCheck({ phone: input });
      expect(r.valid, `${input}: ${r.reason}`).toBe(true);
      expect(r.e164).toBe("+905321234567");
    }
  });

  it("strips the national trunk prefix people include out of habit", () => {
    // 0532… is how a Turk writes it domestically; the 0 is not part of E.164.
    expect(phoneCheck({ phone: "+90 0532 123 45 67" }).e164).toBe("+905321234567");
    expect(phoneCheck({ phone: "020 7946 0958", country: "44" }).e164).toBe("+442079460958");
  });

  it("resolves the longest calling code, so +351 is not read as +3", () => {
    expect(phoneCheck({ phone: "+351912345678" }).country).toBe("Portugal");
    expect(phoneCheck({ phone: "+33612345678" }).country).toBe("France");
  });

  it("refuses a bare national number instead of guessing a country", () => {
    const r = phoneCheck({ phone: "5321234567" });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/ambiguous/i);
  });

  it("checks national length where the plan is stable", () => {
    const r = phoneCheck({ phone: "+90 532 123 456" });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/10 digits; this one is 9/);
    expect(r.lengthChecked).toBe(true);
  });

  it("rejects lengths E.164 itself forbids", () => {
    expect(phoneCheck({ phone: "+1234" }).reason).toMatch(/too short/i);
    expect(phoneCheck({ phone: "+1234567890123456" }).reason).toMatch(/at most 15/);
  });
});

describe("phoneCheck — line type is asserted only where it is knowable", () => {
  it("names mobile and fixed where the ranges are unambiguous", () => {
    expect(phoneCheck({ phone: "+905321234567" }).lineType).toBe("mobile");
    expect(phoneCheck({ phone: "+902121234567" }).lineType).toBe("fixed");
    expect(phoneCheck({ phone: "+447911123456" }).lineType).toBe("mobile");
  });

  it("returns null with a reason rather than guessing", () => {
    // Denmark has no separate mobile range in the plan table.
    const r = phoneCheck({ phone: "+4520123456" });
    expect(r.valid).toBe(true);
    expect(r.lineType).toBeNull();
    expect(r.lineTypeReason).toMatch(/not determined/i);
  });

  it("says outright that a valid number is not a reachable one", () => {
    const r = phoneCheck({ phone: "+905321234567" });
    expect(r.note).toMatch(/does NOT check that the number is assigned, active, or reachable/i);
  });
});

describe("vatCheck — checksums where they are published", () => {
  it.each([
    ["BE0417497106", "Belgium"],
    ["DE136695976", "Germany"],
    ["NL004495445B01", "Netherlands"],
    ["IT00743110157", "Italy"],
    ["PL5260001246", "Poland"],
    ["PT501964843", "Portugal"],
    ["LU26375245", "Luxembourg"],
    ["FR40303265045", "France"],
  ])("accepts %s (%s) and marks the checksum as run", (vat, name) => {
    const r = vatCheck({ vat });
    expect(r.valid, r.reason ?? "").toBe(true);
    expect(r.countryName).toBe(name);
    expect(r.checksumChecked).toBe(true);
  });

  it("catches a mistyped digit where a checksum exists", () => {
    const r = vatCheck({ vat: "BE0417497107" });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/check digits do not match/i);
    expect(r.checksumChecked).toBe(true);
  });

  it("tolerates the separators invoices actually contain", () => {
    expect(vatCheck({ vat: "be 0417.497.106" }).valid).toBe(true);
    expect(vatCheck({ vat: "NL 0044 95445 B01" }).valid).toBe(true);
  });
});

describe("vatCheck — a weaker answer is reported as weaker", () => {
  it("passes format-only countries with checksumChecked false", () => {
    // Structure is all we can assert for these, and saying so is the point.
    const r = vatCheck({ vat: "SE556293998201" });
    expect(r.valid).toBe(true);
    expect(r.checksumChecked, "no published algorithm implemented for SE").toBe(false);
  });

  it("still rejects a format violation in those countries", () => {
    const r = vatCheck({ vat: "DK1234567" }); // DK is 8 digits
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/does not match the Denmark VAT format/i);
  });

  it("rejects a non-EU prefix by name", () => {
    expect(vatCheck({ vat: "US123456789" }).reason).toMatch(/not an EU VAT country prefix/i);
  });
});

describe("vatCheck — never implies registration", () => {
  it("keeps `registered` null and points at VIES", () => {
    // The dangerous misreading is "valid" => "safe to zero-rate". The payload
    // has to close that off itself, not rely on the docs.
    const r = vatCheck({ vat: "DE136695976" });
    expect(r.valid).toBe(true);
    expect(r.registered).toBeNull();
    expect(r.registeredNote).toMatch(/VIES/);
    expect(r.registeredNote).toMatch(/can be unregistered, expired, or belong to someone else/i);
  });
});
