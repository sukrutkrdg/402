import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Two niche anti-scam reads: address-poisoning (is a recipient a look-alike of a
 * real counterparty?) and sanctioned-exposure (does a wallet deal with an OFAC
 * address?). Both pull the wallet's USDC counterparties from CDP SQL — mocked
 * here so the heuristic is what's under test, not the warehouse.
 */
const { sqlMock, compMock } = vi.hoisted(() => ({
  sqlMock: { cdpSql: vi.fn() },
  compMock: { sanctionsCheck: vi.fn() },
}));
vi.mock("@/lib/covalent", () => sqlMock);
vi.mock("@/lib/compliance", () => compMock);

import { addressPoisoning, sanctionedExposure } from "@/lib/wallet-forensics";

const WALLET = "0xfe21a68f21d556a3c4274a44c2fb5410c50cda1c";
// A recipient and a REAL counterparty that shares its head+tail but differs.
const CAND = "0xabcd110000000000000000000000000000001234";
const POISONED = "0xabcd11ffffffffffffffffffffffffffffff5678"; // same abcd11 prefix
const UNRELATED = "0x1111222233334444555566667777888899990000";

// counterparties() issues two cdpSql calls (outbound, inbound) in order.
function cps(out: string[], inc: string[] = []) {
  sqlMock.cdpSql
    .mockResolvedValueOnce(out.map((cp) => ({ cp })))
    .mockResolvedValueOnce(inc.map((cp) => ({ cp })));
}

beforeEach(() => {
  sqlMock.cdpSql.mockReset();
  compMock.sanctionsCheck.mockReset();
});

describe("address-poisoning", () => {
  it("flags a look-alike that shares head/tail with a real counterparty", async () => {
    cps([POISONED, UNRELATED]);
    const r = await addressPoisoning({ wallet: WALLET, to: CAND });
    expect(r.verdict).toBe("poisoning_suspected");
    expect(r.recommendation).toMatch(/ADDRESS-POISONING/);
    expect(r.lookalikeMatches?.[0].address).toBe(POISONED);
  });

  it("treats an exact known counterparty as safe, not poisoning", async () => {
    cps([CAND, UNRELATED]);
    const r = await addressPoisoning({ wallet: WALLET, to: CAND });
    expect(r.verdict).toBe("known_counterparty");
  });

  it("no resemblance when counterparties are unrelated", async () => {
    cps([UNRELATED]);
    const r = await addressPoisoning({ wallet: WALLET, to: CAND });
    expect(r.verdict).toBe("no_resemblance");
  });

  it("does not charge when the warehouse is unavailable", async () => {
    sqlMock.cdpSql.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(addressPoisoning({ wallet: WALLET, to: CAND })).rejects.toThrow(/not charged/);
  });

  it("rejects a missing recipient", async () => {
    await expect(addressPoisoning({ wallet: WALLET })).rejects.toThrow(/recipient/i);
  });
});

describe("sanctioned-exposure", () => {
  it("reports exposure when a counterparty is OFAC-listed", async () => {
    cps([POISONED, UNRELATED]);
    compMock.sanctionsCheck.mockImplementation(async ({ address }: { address: string }) => ({
      sanctioned: address.toLowerCase() === POISONED.toLowerCase(),
    }));
    const r = await sanctionedExposure({ wallet: WALLET });
    expect(r.verdict).toBe("sanctioned_exposure");
    expect(r.sanctionedCounterparties).toContain(POISONED.toLowerCase());
  });

  it("clear when no counterparty is listed", async () => {
    cps([POISONED, UNRELATED]);
    compMock.sanctionsCheck.mockResolvedValue({ sanctioned: false });
    const r = await sanctionedExposure({ wallet: WALLET });
    expect(r.verdict).toBe("clear");
  });

  it("no_activity when the wallet has no counterparties", async () => {
    cps([], []);
    const r = await sanctionedExposure({ wallet: WALLET });
    expect(r.verdict).toBe("no_activity");
  });

  it("does not charge when the warehouse is unavailable", async () => {
    sqlMock.cdpSql.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(sanctionedExposure({ wallet: WALLET })).rejects.toThrow(/not charged/);
  });
});
