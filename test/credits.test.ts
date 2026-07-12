import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Prepaid credits — the one path that mints money. Regression for the audit
 * HIGH: a failed ledger write must THROW (≥400 → x402 never settles), never
 * return a token whose balance was silently not written.
 */
const { kvMock } = vi.hoisted(() => ({
  kvMock: {
    kvConfigured: vi.fn(),
    kvGetNumber: vi.fn(),
    kvSet: vi.fn(),
    kvDecrBy: vi.fn(),
    kvIncrBy: vi.fn(),
    kvDel: vi.fn(),
  },
}));
vi.mock("@/lib/kv", () => kvMock);

import { buyCredits, debitCredit, refundCredit, CREDIT_TIERS } from "@/lib/credits";

const GOOD_TOKEN = `ck_${"a".repeat(36)}`;

describe("buyCredits — fail closed on ledger failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvMock.kvConfigured.mockReturnValue(true);
    kvMock.kvSet.mockResolvedValue(undefined);
  });

  it("throws (payment NOT settled) when the balance write returns null", async () => {
    kvMock.kvIncrBy.mockResolvedValue(null); // KV configured but unreachable
    await expect(buyCredits({ tier: "5" })).rejects.toThrow(/not settled/i);
  });

  it("mints a one-time ck_ token with the tier's balance on success", async () => {
    kvMock.kvIncrBy.mockResolvedValue(550);
    const r = (await buyCredits({ tier: "5" })) as { creditToken: string; balanceUsd: number; paidUsd: number };
    expect(r.creditToken).toMatch(/^ck_[0-9a-f]{36}$/);
    expect(r.balanceUsd).toBe(5.5);
    expect(r.paidUsd).toBe(5);
  });

  it("supports the $0.25 starter tier with exact integer cents", async () => {
    expect(CREDIT_TIERS["0.25"]).toEqual({ usd: 0.25, credits: 25 });
    kvMock.kvIncrBy.mockResolvedValue(25);
    const r = (await buyCredits({ tier: "0.25" })) as { balanceUsd: number; paidUsd: number };
    expect(r.balanceUsd).toBe(0.25);
    expect(r.paidUsd).toBe(0.25);
  });

  it("rejects an unknown tier", async () => {
    await expect(buyCredits({ tier: "7" })).rejects.toThrow(/Invalid tier/);
  });

  it("throws when KV is not configured at all (never sells without a ledger)", async () => {
    kvMock.kvConfigured.mockReturnValue(false);
    await expect(buyCredits({ tier: "1" })).rejects.toThrow(/unavailable/i);
  });
});

describe("debitCredit — atomic debit-first with symmetric compensation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvMock.kvConfigured.mockReturnValue(true);
    kvMock.kvIncrBy.mockResolvedValue(0);
    kvMock.kvDel.mockResolvedValue(undefined);
  });

  it("debits and reports the remaining balance", async () => {
    kvMock.kvDecrBy.mockResolvedValue(97);
    const r = await debitCredit(GOOD_TOKEN, 3);
    expect(r).toEqual({ ok: true, remaining: 97 });
    expect(kvMock.kvIncrBy).not.toHaveBeenCalled(); // no refund on success
  });

  it("refunds exactly what it debited on overdraw and deletes a zero probe key", async () => {
    // Unknown token: DECRBY creates the key at -cents.
    kvMock.kvDecrBy.mockResolvedValue(-3);
    const r = await debitCredit(GOOD_TOKEN, 3);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("insufficient");
    expect(kvMock.kvIncrBy).toHaveBeenCalledTimes(1);
    expect(kvMock.kvIncrBy.mock.calls[0][1]).toBe(3); // refund == debit
    expect(kvMock.kvDel).toHaveBeenCalledTimes(1); // restored balance 0 → key removed
  });

  it("keeps a genuinely underfunded (non-zero) balance instead of deleting it", async () => {
    kvMock.kvDecrBy.mockResolvedValue(-1); // balance was 2, price 3
    const r = await debitCredit(GOOD_TOKEN, 3);
    expect(r.reason).toBe("insufficient");
    expect(r.balance).toBe(2);
    expect(kvMock.kvDel).not.toHaveBeenCalled();
  });

  it("rejects a malformed token without touching the ledger", async () => {
    const r = await debitCredit("ck_short", 3);
    expect(r.reason).toBe("bad_token");
    expect(kvMock.kvDecrBy).not.toHaveBeenCalled();
  });

  it("fails closed when KV reports an outage mid-debit", async () => {
    kvMock.kvDecrBy.mockResolvedValue(null);
    const r = await debitCredit(GOOD_TOKEN, 3);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_kv");
  });
});

describe("refundCredit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvMock.kvConfigured.mockReturnValue(true);
    kvMock.kvIncrBy.mockResolvedValue(3);
  });

  it("returns the cents to a valid token", async () => {
    await refundCredit(GOOD_TOKEN, 3);
    expect(kvMock.kvIncrBy).toHaveBeenCalledTimes(1);
    expect(kvMock.kvIncrBy.mock.calls[0][1]).toBe(3);
  });

  it("ignores malformed tokens silently", async () => {
    await refundCredit("not-a-token", 3);
    expect(kvMock.kvIncrBy).not.toHaveBeenCalled();
  });
});
