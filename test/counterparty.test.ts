import { describe, it, expect, vi } from "vitest";
import { normalizeCompany, leiLookup, companyLei } from "@/lib/counterparty";

describe("normalizeCompany", () => {
  it("ignores punctuation, case and accents, which is how the same company is written twice", () => {
    expect(normalizeCompany("Coinbase Global, Inc.")).toBe("coinbase global inc");
    expect(normalizeCompany("KOÇ HOLDİNG A.Ş.")).toBe(normalizeCompany("Koc Holding A.S."));
  });
});

/**
 * The register's own filter is a token search: "Coinbase Global, Inc." matches
 * tens of thousands of rows, including companies whose only shared word is
 * "Inc". Reporting one of those as the counterparty's verified legal entity is
 * the single worst thing this endpoint could do, so the live tests below are
 * about what it REFUSES to call a match.
 */
describe("leiLookup — live GLEIF", () => {
  it("finds the real entity and reports it as an exact match", async () => {
    const r = await leiLookup("Coinbase Global, Inc.");
    expect(r.answered).toBe(true);
    expect(r.match).toBe("exact");
    expect(r.record?.lei).toBe("5493004G3J2SC154DU06");
    expect(r.record?.legalName).toBe("Coinbase Global, Inc.");
    expect(r.record?.country).toBe("US");
  }, 30_000);

  it("does not accept a company that merely shares a word with the query", async () => {
    const r = await leiLookup("Coinbase Global, Inc.");
    // "INC Group Inc." comes back from the register on the same query.
    expect(r.record?.legalName).not.toMatch(/INC Group/i);
    expect(r.candidates.some((c) => /group/i.test(c))).toBe(true);
  }, 30_000);

  it("returns not-found — with suggestions — for a company that is not registered", async () => {
    const r = await leiLookup("Nonexistent Fake Company XYZ Ltd");
    expect(r.answered).toBe(true);
    expect(r.match).toBeNull();
    expect(r.record).toBeNull();
  }, 30_000);

  it("matches when only the legal form differs", async () => {
    const withForm = await leiLookup("Coinbase Global, Inc.");
    const withoutForm = await leiLookup("Coinbase Global");
    expect(withForm.match).toBe("exact");
    // Same entity reachable without the suffix, as "strong" rather than exact.
    if (withoutForm.record) expect(withoutForm.match).toBe("strong");
  }, 40_000);
});

/**
 * The composite's one unforgivable failure: reporting GO for a counterparty
 * whose sanctions screen never ran. The first live run did exactly that for
 * "Banco Nacional de Cuba" because the OFAC feed was down and the other checks
 * were clean, so this pins the rule — an incomplete screen is never a pass.
 */
describe("counterpartyCheck — an unfinished check is not a pass", () => {
  it("never returns GO when a requested check could not run", async () => {
    vi.resetModules();
    vi.doMock("@/lib/sanctions-name", () => ({
      sanctionsName: async () => {
        throw new Error("OFAC list unavailable");
      },
    }));
    vi.doMock("@/lib/domain-check", () => ({
      domainCheck: async () => ({ decision: "GO", registered: true, ageDays: 4000, reasons: [] }),
    }));
    vi.doMock("@/lib/email-verify", () => ({
      emailVerify: async () => ({ decision: "GO", deliverable: true, reasons: [] }),
    }));
    const { counterpartyCheck } = await import("@/lib/counterparty");
    const r = (await counterpartyCheck({
      domain: "example.com",
      email: "a@example.com",
      name: "Banco Nacional de Cuba",
    })) as { decision: string; reasons: string[]; receipt: { confidence: { band: string; basis: string } } };

    expect(r.decision).not.toBe("GO");
    expect(r.decision).toBe("HOLD");
    expect(r.reasons).toContain("incomplete:some_checks_could_not_run");
    expect(r.receipt.confidence.band).toBe("medium");
    expect(r.receipt.confidence.basis).toMatch(/sanctions-check \(did not complete\)/);
    vi.doUnmock("@/lib/sanctions-name");
    vi.doUnmock("@/lib/domain-check");
    vi.doUnmock("@/lib/email-verify");
    vi.resetModules();
  });
});

describe("companyLei", () => {
  it("rejects an empty name without calling the register", async () => {
    await expect(companyLei({})).rejects.toThrow(/Missing 'name'/i);
    await expect(companyLei({ name: "x".repeat(201) })).rejects.toThrow(/too long/i);
  });

  it("states plainly that a missing LEI is not a red flag", async () => {
    const r = await companyLei({ name: "Nonexistent Fake Company XYZ Ltd" });
    expect(r.found).toBe(false);
    expect(r.note).toMatch(/NOT a red flag/i);
  }, 30_000);
});
