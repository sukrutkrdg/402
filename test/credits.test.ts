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
    kvIncrByOnce: vi.fn(),
    kvLPush: vi.fn(),
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

/**
 * A refund can be wrong in two directions and both cost real money. Losing it
 * leaves a customer paying for a call that failed; applying it twice pays them
 * for it. The old code retried a bare INCRBY on a null answer, which chose the
 * second — a null is "no reply", not "no write", and a timed-out INCRBY may
 * already have run.
 */
describe("refundCredit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvMock.kvConfigured.mockReturnValue(true);
    kvMock.kvIncrByOnce.mockResolvedValue(3);
  });

  it("returns the cents to a valid token", async () => {
    await refundCredit(GOOD_TOKEN, 3);
    expect(kvMock.kvIncrByOnce).toHaveBeenCalledTimes(1);
    expect(kvMock.kvIncrByOnce.mock.calls[0][1]).toBe(3);
  });

  it("ignores malformed tokens silently", async () => {
    await refundCredit("not-a-token", 3);
    expect(kvMock.kvIncrByOnce).not.toHaveBeenCalled();
    expect(kvMock.kvIncrBy).not.toHaveBeenCalled();
  });

  it("never uses a bare increment, which cannot be retried safely", async () => {
    await refundCredit(GOOD_TOKEN, 3);
    expect(kvMock.kvIncrBy).not.toHaveBeenCalled();
  });

  it("retries a lost reply under the SAME guard, so it can only apply once", async () => {
    // First call answers null (timeout). Whether the write landed is unknowable
    // from here — the guard is what makes asking again safe.
    kvMock.kvIncrByOnce.mockResolvedValueOnce(null).mockResolvedValueOnce(3);
    await refundCredit(GOOD_TOKEN, 3);
    expect(kvMock.kvIncrByOnce).toHaveBeenCalledTimes(2);
    const [first, second] = kvMock.kvIncrByOnce.mock.calls;
    expect(second[2], "a fresh guard per attempt would double-credit").toBe(first[2]);
    expect(String(first[2])).toMatch(/^refund:/);
  });

  it("gives a different guard to a different refund", async () => {
    await refundCredit(GOOD_TOKEN, 3);
    await refundCredit(GOOD_TOKEN, 3);
    expect(kvMock.kvIncrByOnce.mock.calls[0][2]).not.toBe(kvMock.kvIncrByOnce.mock.calls[1][2]);
  });

  it("stops as soon as the guard proves it already applied", async () => {
    kvMock.kvIncrByOnce.mockResolvedValueOnce(null).mockResolvedValueOnce(Symbol.for("kv.already"));
    await refundCredit(GOOD_TOKEN, 3);
    expect(kvMock.kvIncrByOnce).toHaveBeenCalledTimes(2);
  });

  it("records the debt instead of dropping it when KV never comes back", async () => {
    // The customer has been charged for a call they did not get, and this is the
    // last moment anyone knows it.
    kvMock.kvIncrByOnce.mockResolvedValue(null);
    await refundCredit(GOOD_TOKEN, 7);
    expect(kvMock.kvLPush).toHaveBeenCalledTimes(1);
    const [key, payload] = kvMock.kvLPush.mock.calls[0];
    expect(key).toBe("credits:refunds:stuck");
    expect(JSON.parse(payload as string).cents).toBe(7);
  });

  it("does not report a debt it managed to pay", async () => {
    await refundCredit(GOOD_TOKEN, 7);
    expect(kvMock.kvLPush).not.toHaveBeenCalled();
  });
});
