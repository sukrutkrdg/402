import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The prepaid rail's own books.
 *
 * A credit spend logs as a paid call — true, it was paid for — but no money
 * moves at that moment: it moved when the pack was bought. So the ordinary
 * counters show credit traffic as revenue-earning calls while revenue stays
 * flat, and the prepaid business is invisible between the two. Asked for on
 * 2026-09-14 after the first real pack was bought and spent, when the operator
 * could not tell from the panel that either had happened.
 *
 * The number that matters is drawdown. A pack sold and never spent is revenue
 * today and a customer who did not come back; unspent credit is money we have
 * taken and not yet earned, which is a liability, not a win.
 */
const { kvMock } = vi.hoisted(() => ({
  kvMock: {
    kvConfigured: vi.fn(),
    kvGetNumber: vi.fn(),
    kvSet: vi.fn(),
    kvDecrBy: vi.fn(),
    kvIncrBy: vi.fn(),
    kvIncrByOnce: vi.fn(),
    kvDel: vi.fn(),
    kvSAdd: vi.fn(),
    kvSRem: vi.fn(),
    kvSMembers: vi.fn(),
    kvExpire: vi.fn(),
    kvLPush: vi.fn(),
    kvLRange: vi.fn(),
    kvPipeline: vi.fn(),
  },
}));
vi.mock("@/lib/kv", () => kvMock);

import { buyCredits, debitCredit, creditsLedger, recoverCredits } from "@/lib/credits";

const incrementsTo = (key: string) =>
  kvMock.kvIncrBy.mock.calls.filter((c: unknown[]) => String(c[0]) === key).map((c: unknown[]) => Number(c[1]));

describe("credits ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvMock.kvConfigured.mockReturnValue(true);
    kvMock.kvSet.mockResolvedValue(undefined);
    kvMock.kvIncrBy.mockResolvedValue(100);
    kvMock.kvDel.mockResolvedValue(undefined);
  });

  it("books a sale with what was paid and what was issued, which differ on bonus tiers", async () => {
    await buyCredits({ tier: "5" });
    expect(incrementsTo("credits:packs")).toEqual([1]);
    expect(incrementsTo("credits:paid:cents"), "what the customer paid").toEqual([500]);
    expect(incrementsTo("credits:minted:cents"), "what they can spend, incl. the +10%").toEqual([550]);
  });

  it("counts a spend against drawdown, not against a new sale", async () => {
    kvMock.kvDecrBy.mockResolvedValue(97);
    await debitCredit(`ck_${"a".repeat(36)}`, 3);
    expect(incrementsTo("credits:spent:cents")).toEqual([3]);
    expect(incrementsTo("credits:spent:calls")).toEqual([1]);
    expect(incrementsTo("credits:packs"), "spending is not selling").toEqual([]);
  });

  it("does not book an overdraw, which delivered nothing", async () => {
    kvMock.kvDecrBy.mockResolvedValue(-3); // unknown/underfunded token
    await debitCredit(`ck_${"a".repeat(36)}`, 3);
    expect(incrementsTo("credits:spent:cents")).toEqual([]);
    expect(incrementsTo("credits:spent:calls")).toEqual([]);
  });

  /**
   * Recovery re-issues a balance that was bought once and booked once. Counting
   * the re-issue as a sale would show a customer who merely lost their token as
   * having bought the same pack twice — inventing revenue out of a support event.
   */
  it("does not count a recovery as a sale", async () => {
    kvMock.kvSMembers.mockResolvedValue(["credit:" + "b".repeat(24)]);
    kvMock.kvGetNumber.mockResolvedValue(40);
    kvMock.kvDecrBy.mockResolvedValue(0);
    await recoverCredits("0x" + "1".repeat(40));
    expect(incrementsTo("credits:packs"), "re-issuing is not selling").toEqual([]);
    expect(incrementsTo("credits:paid:cents")).toEqual([]);
  });

  it("reports outstanding credit as issued minus drawn down", async () => {
    const at: Record<string, number> = {
      "credits:packs": 3,
      "credits:paid:cents": 2600,
      "credits:minted:cents": 3050,
      "credits:spent:cents": 1220,
      "credits:spent:calls": 244,
    };
    kvMock.kvGetNumber.mockImplementation(async (k: string) => at[k] ?? 0);
    const l = (await creditsLedger())!;
    expect(l.packsSold).toBe(3);
    expect(l.paidUsd).toBe(26);
    expect(l.creditedUsd).toBe(30.5);
    expect(l.spentUsd).toBe(12.2);
    expect(l.outstandingUsd, "issued minus spent — money taken, not yet earned").toBe(18.3);
    expect(l.drawdownPct).toBe(40);
  });

  it("says nothing rather than zero when there is no ledger to read", async () => {
    kvMock.kvConfigured.mockReturnValue(false);
    expect(await creditsLedger()).toBeNull();
  });
});
