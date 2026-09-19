import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A wallet coming back is the signal this catalogue has never produced.
 *
 * Repeat rate has been measured by hand for months — 1.6 calls per payer in
 * August, 1.78 across the catalogue in September — always after the fact, from
 * the discovery index. Nothing told us on the day.
 *
 * It matters more than the amount. On 2026-09-19 one wallet bought thirteen
 * services in twenty-seven minutes, our largest external day to date, and it
 * turned out to be sampling at least twenty-five different x402 sellers: a
 * crawler, not demand. A wallet that returns on a DIFFERENT day is the first
 * thing that would be.
 */
const { kvMock, sqlMock, cfgMock, buyerMock } = vi.hoisted(() => ({
  kvMock: {
    kvConfigured: vi.fn(),
    kvSMembers: vi.fn(),
    kvSAdd: vi.fn(),
    kvExpire: vi.fn(),
  },
  sqlMock: { cdpSql: vi.fn() },
  cfgMock: { getConfig: vi.fn(), USDC_BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  buyerMock: { getBuyerAddress: vi.fn() },
}));
vi.mock("@/lib/kv", () => kvMock);
vi.mock("@/lib/covalent", () => sqlMock);
vi.mock("@/lib/config", () => cfgMock);
vi.mock("@/lib/x402-client", () => buyerMock);

import { checkRepeatBuyers, repeatBuyerMessage } from "@/lib/repeat-buyers";

const PAYTO = "0x973a31858f4d2125f48c880542da11a2796f12d6";
const BUYER = "0xfe21a68f21d556a3c4274a44c2fb5410c50cda1c";
const STRANGER = "0x35ed8c8bf74b610b5d7e401b18420e1760603e59";
const row = (from: string, usdc: number) => ({ f: from, v: String(Math.round(usdc * 1e6)) });

describe("repeat buyers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvMock.kvConfigured.mockReturnValue(true);
    kvMock.kvSMembers.mockResolvedValue([]);
    kvMock.kvSAdd.mockResolvedValue(undefined);
    kvMock.kvExpire.mockResolvedValue(undefined);
    cfgMock.getConfig.mockReturnValue({ payTo: PAYTO, ownWallets: [PAYTO] });
    buyerMock.getBuyerAddress.mockReturnValue(BUYER);
  });

  it("reports nobody on the first run, and learns who already paid", async () => {
    // Otherwise the detector's first morning announces every existing payer as
    // "returning" — they predate it, which is not the same as coming back.
    sqlMock.cdpSql.mockResolvedValue([row(STRANGER, 0.7), row("0x" + "a".repeat(40), 0.03)]);
    const r = (await checkRepeatBuyers("2026-09-19"))!;
    expect(r.returning).toEqual([]);
    expect(r.firstTime).toBe(2);
    expect(kvMock.kvSAdd).toHaveBeenCalledWith("payers:seen", STRANGER);
  });

  it("flags a wallet that paid on an earlier day", async () => {
    kvMock.kvSMembers.mockResolvedValue([STRANGER]);
    sqlMock.cdpSql.mockResolvedValue([row(STRANGER, 0.25), row(STRANGER, 0.1)]);
    const r = (await checkRepeatBuyers("2026-09-25"))!;
    expect(r.returning).toHaveLength(1);
    expect(r.returning[0].wallet).toBe(STRANGER);
    expect(r.returning[0].payments, "both payments in the day are counted").toBe(2);
    expect(r.returning[0].usdc).toBeCloseTo(0.35, 4);
    expect(r.firstTime).toBe(0);
  });

  /**
   * The buyer wallet settles a dozen keepalive payments every morning, so it
   * would be the most loyal repeat customer this ever found. Same mistake the
   * payers dashboard made until it started deriving the address instead of
   * reading a list.
   */
  it("never counts our own wallets as customers", async () => {
    kvMock.kvSMembers.mockResolvedValue([BUYER, PAYTO, STRANGER]);
    sqlMock.cdpSql.mockResolvedValue([row(BUYER, 0.12), row(PAYTO, 5)]);
    const r = (await checkRepeatBuyers("2026-09-25"))!;
    expect(r.returning).toEqual([]);
    expect(r.firstTime).toBe(0);
  });

  it("treats a failed query as unknown, not as an empty day", async () => {
    // Saying "nobody came back" because the warehouse was unreachable would
    // also teach the seen-set nothing, so a real return the next day would
    // read as first-time.
    kvMock.kvSMembers.mockResolvedValue([STRANGER]);
    sqlMock.cdpSql.mockResolvedValue(null);
    const r = (await checkRepeatBuyers("2026-09-25"))!;
    expect(r.degraded).toBe(true);
    expect(r.returning).toEqual([]);
    expect(kvMock.kvSAdd).not.toHaveBeenCalled();
  });

  it("says nothing rather than zero when there is no ledger", async () => {
    kvMock.kvConfigured.mockReturnValue(false);
    expect(await checkRepeatBuyers("2026-09-25")).toBeNull();
  });

  it("names the wallet in the alert, because that is what gets looked up", async () => {
    const msg = repeatBuyerMessage({
      date: "2026-09-25",
      returning: [{ wallet: STRANGER, usdc: 0.35, payments: 2 }],
      firstTime: 0,
      degraded: false,
    });
    expect(msg).toContain(STRANGER);
    expect(msg).toContain("2026-09-25");
    expect(msg).toMatch(/payers\?date=2026-09-25/);
  });
});
