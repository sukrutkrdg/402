import { describe, it, expect } from "vitest";
import { bicCheck, binCheck, sepaCreditorCheck, taxIdCheck } from "@/lib/business-bank";
import { addressCheck } from "@/lib/business-geo";
import { trackingDetect, hsCodeSuggest } from "@/lib/business-ship";
import { urlRisk } from "@/lib/business-trust";
import { receiptParse, meetingSlots, bankCsvNormalize, qrEncode } from "@/lib/business-office";

describe("bic-check", () => {
  it("accepts an 11-char head-office BIC", () => {
    const r = bicCheck({ bic: "DEUTDEFFXXX" });
    expect(r.valid).toBe(true);
    if (!r.valid) return;
    expect((r as any).country).toBe("DE");
    expect((r as any).isHeadOffice).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(bicCheck({ bic: "DEUTDE" }).valid).toBe(false);
  });
});

describe("bin-check", () => {
  it("maps Visa and refuses a full PAN", () => {
    const r = binCheck({ bin: "424242" });
    expect(r.valid).toBe(true);
    if (r.valid) expect((r as any).scheme).toBe("Visa");
    expect(binCheck({ bin: "4242424242424242" }).valid).toBe(false);
  });
});

describe("sepa-creditor", () => {
  it("accepts the EPC example identifier", () => {
    const r = sepaCreditorCheck({ creditorId: "DE98ZZZ09999999999" });
    expect(r.valid, "reason" in r ? String(r.reason) : "").toBe(true);
    if (!r.valid) return;
    expect((r as any).country).toBe("DE");
  });

  it("catches a bad checksum", () => {
    expect(sepaCreditorCheck({ creditorId: "DE00ZZZ09999999999" }).valid).toBe(false);
  });
});

describe("tax-id-check", () => {
  it("validates EORI shape and TCKN checksum", () => {
    expect(taxIdCheck({ kind: "EORI", value: "DE123456789012345" }).valid).toBe(true);
    expect(taxIdCheck({ kind: "TCKN", value: "10000000078" }).valid).toBe(true);
    expect(taxIdCheck({ kind: "TCKN", value: "10000000077" }).valid).toBe(false);
  });
});

describe("address-check", () => {
  it("flags a bad TR postal code", () => {
    const bad = addressCheck({ country: "TR", line1: "Cadde 1", city: "Istanbul", postal: "ABC" });
    expect(bad.valid).toBe(false);
    const ok = addressCheck({ country: "TR", line1: "Cadde 1", city: "Istanbul", postal: "34000" });
    expect(ok.valid).toBe(true);
  });
});

describe("tracking-detect", () => {
  it("recognises UPS 1Z numbers", () => {
    const r = trackingDetect({ tracking: "1Z999AA10123456784" });
    expect(r.carrier).toBe("UPS");
    expect(r.trackingUrl).toMatch(/ups\.com/);
  });
});

describe("hs-code", () => {
  it("suggests a chapter for headphones", () => {
    const r = hsCodeSuggest({ q: "wireless bluetooth phone accessories" });
    expect(r.found).toBe(true);
    expect(r.matches.some((m) => m.chapter === "85")).toBe(true);
  });
});

describe("url-risk", () => {
  it("holds http and brand lookalikes", () => {
    expect(urlRisk({ url: "http://example.com" }).decision).not.toBe("go");
    const r = urlRisk({ url: "https://coinbase-login.evil.example/wallet", brand: "coinbase.com" });
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe("receipt-parse", () => {
  it("pulls a total and IBAN", () => {
    const r = receiptParse({
      text: "Invoice #A-100\nTOTAL: 120.50 USD\nIBAN GB82WEST12345698765432\nDate 2026-09-01",
    });
    expect(r.totalHint).toBe("120.50");
    expect(r.ibans[0]).toMatch(/^GB82/);
  });
});

describe("meeting-slots", () => {
  it("finds overlap across two zones", () => {
    const r = meetingSlots({
      zones: "Europe/Istanbul,America/New_York",
      date: "2026-09-15",
      startHour: "9",
      endHour: "18",
    });
    expect(r.slotCount).toBeGreaterThan(0);
  });
});

describe("bank-csv", () => {
  it("normalises a simple export", () => {
    const r = bankCsvNormalize({
      text: "Date,Description,Amount\n2026-01-02,Coffee,-4.50\n2026-01-03,Payroll,1000.00",
    });
    expect(r.rowCount).toBe(2);
    expect(r.rows[1].amount).toBe(1000);
  });
});

describe("qr-encode", () => {
  it("returns svg markup", async () => {
    const r = await qrEncode({ text: "https://402.com.tr" });
    expect(r.format).toBe("svg");
    expect(String((r as { svg?: string }).svg)).toMatch(/<svg/i);
  });
});
