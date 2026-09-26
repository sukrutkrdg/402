import { describe, it, expect, vi, beforeEach } from "vitest";

const { kv } = vi.hoisted(() => ({
  kv: {
    kvConfigured: vi.fn(() => true),
    kvGetNumber: vi.fn(async () => 0),
    kvSet: vi.fn(),
    kvDecrBy: vi.fn(),
    kvIncrBy: vi.fn(async () => 0),
    kvIncrByOnce: vi.fn(async () => 1),
    kvLPush: vi.fn(),
    kvLRange: vi.fn(async () => []),
    kvDel: vi.fn(),
    kvSAdd: vi.fn(),
    kvSRem: vi.fn(),
    kvSMembers: vi.fn(async () => []),
    kvExpire: vi.fn(),
    kvPipeline: vi.fn(async () => []),
    kvEval: vi.fn(),
  },
}));
vi.mock("@/lib/kv", () => kv);

import { debitCreditMills, refundCreditMills, DEBIT_MILLS_LUA, REFUND_MILLS_LUA } from "@/lib/credits";
import { priceMills } from "@/lib/price";

const T = `ck_${"a".repeat(36)}`;
beforeEach(() => vi.clearAllMocks());

describe("priceMills", () => {
  it("prices in tenths of a cent", () => {
    expect(priceMills("$0.002")).toBe(2);
    expect(priceMills("$0.005")).toBe(5);
    expect(priceMills("$0.03")).toBe(30);
    expect(priceMills("$0.0001")).toBe(1);
    expect(priceMills("free")).toBe(0);
  });
});

describe("debitCreditMills", () => {
  it("sends a sub-cent price through the remainder script and reports the spendable balance", async () => {
    kv.kvEval.mockResolvedValueOnce([0, 5, 2]);
    const r = await debitCreditMills(T, 2);
    expect(kv.kvEval).toHaveBeenCalledWith(DEBIT_MILLS_LUA, [expect.stringMatching(/^credit:[0-9a-f]{24}$/), expect.stringMatching(/:mills$/)], [2]);
    expect(r).toEqual({ ok: true, remainingMills: 48 });
    expect(kv.kvIncrBy).toHaveBeenCalledWith(expect.any(String), 0); // books: no whole cent left yet
  });

  it("an insufficient balance is refused with what is left", async () => {
    kv.kvEval.mockResolvedValueOnce([-1, 0, 8]);
    expect(await debitCreditMills(T, 5)).toMatchObject({ ok: false, reason: "insufficient", balanceMills: 0 });
  });

  it("a whole-cent price keeps the ordinary cent path", async () => {
    kv.kvDecrBy.mockResolvedValueOnce(97);
    expect(await debitCreditMills(T, 30)).toEqual({ ok: true, remainingMills: 970 });
    expect(kv.kvDecrBy).toHaveBeenCalledWith(expect.any(String), 3);
    expect(kv.kvEval).not.toHaveBeenCalled();
  });

  it("a bad token never reaches KV", async () => {
    expect(await debitCreditMills("nope", 2)).toMatchObject({ ok: false, reason: "bad_token" });
    expect(kv.kvEval).not.toHaveBeenCalled();
  });
});

describe("refundCreditMills", () => {
  it("runs the guarded inverse once and unwinds the books", async () => {
    kv.kvEval.mockResolvedValueOnce([1]);
    await refundCreditMills(T, 2);
    expect(kv.kvEval).toHaveBeenCalledTimes(1);
    expect(kv.kvEval.mock.calls[0][0]).toBe(REFUND_MILLS_LUA);
    expect(kv.kvEval.mock.calls[0][1][2]).toMatch(/^refund:/);
    expect(kv.kvIncrBy).toHaveBeenCalledWith(expect.any(String), -1);
  });

  it("retries a lost reply with the SAME guard", async () => {
    kv.kvEval.mockResolvedValueOnce(null).mockResolvedValueOnce([-9]);
    await refundCreditMills(T, 2);
    expect(kv.kvEval).toHaveBeenCalledTimes(2);
    expect(kv.kvEval.mock.calls[0][1][2]).toBe(kv.kvEval.mock.calls[1][1][2]);
    expect(kv.kvIncrBy).not.toHaveBeenCalled(); // already applied: books untouched
  });
});
