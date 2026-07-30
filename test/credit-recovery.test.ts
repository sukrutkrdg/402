import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Credit recovery moves real balance between keys, so the invariant that matters
 * is conservation: whatever leaves the old token must land on the new one, and a
 * concurrent spend must not let the buyer re-issue money they already spent.
 */
const { kvMock } = vi.hoisted(() => ({
  kvMock: {
    kvConfigured: vi.fn(),
    kvGetNumber: vi.fn(),
    kvSet: vi.fn(),
    kvDecrBy: vi.fn(),
    kvIncrBy: vi.fn(),
    kvDel: vi.fn(),
    kvSAdd: vi.fn(),
    kvSRem: vi.fn(),
    kvSMembers: vi.fn(),
    kvExpire: vi.fn(),
  },
}));
vi.mock("@/lib/kv", () => kvMock);

import { recoverCredits, linkCreditOwner } from "@/lib/credits";

const OWNER = "0x973a31858f4d2125f48c880542da11a2796f12d6";

describe("recoverCredits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvMock.kvConfigured.mockReturnValue(true);
    kvMock.kvSet.mockResolvedValue(undefined);
    kvMock.kvSAdd.mockResolvedValue(undefined);
    kvMock.kvSRem.mockResolvedValue(undefined);
    kvMock.kvExpire.mockResolvedValue(undefined);
    kvMock.kvDel.mockResolvedValue(undefined);
  });

  it("moves the whole balance onto a fresh token", async () => {
    kvMock.kvSMembers.mockResolvedValue(["credit:old"]);
    // balance read: 100 before draining, 0 after
    kvMock.kvGetNumber.mockResolvedValueOnce(100).mockResolvedValueOnce(0);
    kvMock.kvDecrBy.mockResolvedValue(0); // drained cleanly
    kvMock.kvIncrBy.mockResolvedValue(100); // mint credits the new key

    const r = await recoverCredits(OWNER);
    expect(r.recoveredCents).toBe(100);
    expect(r.tokensMerged).toBe(1);
    expect(r.minted?.creditToken).toMatch(/^ck_[0-9a-f]{36}$/);
    expect(r.minted?.balanceUsd).toBe(1);
    // Old key drained by exactly its balance, then removed.
    expect(kvMock.kvDecrBy).toHaveBeenCalledWith("credit:old", 100);
    expect(kvMock.kvDel).toHaveBeenCalledWith("credit:old");
  });

  it("merges several tokens into one", async () => {
    kvMock.kvSMembers.mockResolvedValue(["credit:a", "credit:b"]);
    kvMock.kvGetNumber
      .mockResolvedValueOnce(100) // a: balance
      .mockResolvedValueOnce(0) //  a: after drain
      .mockResolvedValueOnce(25) //  b: balance
      .mockResolvedValueOnce(0); //  b: after drain
    kvMock.kvDecrBy.mockResolvedValue(0);
    kvMock.kvIncrBy.mockResolvedValue(125);

    const r = await recoverCredits(OWNER);
    expect(r.recoveredCents).toBe(125);
    expect(r.tokensMerged).toBe(2);
  });

  it("does not re-issue cents a concurrent call already spent", async () => {
    kvMock.kvSMembers.mockResolvedValue(["credit:old"]);
    kvMock.kvGetNumber.mockResolvedValueOnce(100).mockResolvedValueOnce(0);
    // Someone spent 30¢ between the read and the decrement → overdrawn by 30.
    kvMock.kvDecrBy.mockResolvedValue(-30);
    kvMock.kvIncrBy.mockResolvedValue(70);

    const r = await recoverCredits(OWNER);
    expect(r.recoveredCents).toBe(70); // not 100
    // The over-decremented part is put back before anything is minted.
    expect(kvMock.kvIncrBy).toHaveBeenCalledWith("credit:old", 30);
  });

  it("reports nothing to recover for a wallet with no balance", async () => {
    kvMock.kvSMembers.mockResolvedValue(["credit:spent"]);
    kvMock.kvGetNumber.mockResolvedValue(0);

    const r = await recoverCredits(OWNER);
    expect(r.recoveredCents).toBe(0);
    expect(r.minted).toBeUndefined();
    // A spent key stops being tracked so the index doesn't grow forever.
    expect(kvMock.kvSRem).toHaveBeenCalledWith(`credit:owner:${OWNER}`, "credit:spent");
  });

  it("reports nothing for a wallet that never bought", async () => {
    kvMock.kvSMembers.mockResolvedValue([]);
    const r = await recoverCredits(OWNER);
    expect(r.recoveredCents).toBe(0);
    expect(kvMock.kvIncrBy).not.toHaveBeenCalled();
  });

  it("changes nothing when the ledger read fails", async () => {
    kvMock.kvSMembers.mockResolvedValue(["credit:old"]);
    kvMock.kvGetNumber.mockResolvedValueOnce(100);
    kvMock.kvDecrBy.mockResolvedValue(null); // KV outage

    await expect(recoverCredits(OWNER)).rejects.toThrow(/ledger/i);
    expect(kvMock.kvDel).not.toHaveBeenCalled();
  });

  it("fails closed with no durable store", async () => {
    kvMock.kvConfigured.mockReturnValue(false);
    await expect(recoverCredits(OWNER)).rejects.toThrow(/storage/i);
  });
});

describe("linkCreditOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvMock.kvConfigured.mockReturnValue(true);
  });

  it("indexes the token hash, never the token itself", async () => {
    const token = `ck_${"b".repeat(36)}`;
    await linkCreditOwner(OWNER, token);
    const [, member] = kvMock.kvSAdd.mock.calls[0];
    expect(member).not.toContain(token);
    expect(member).toMatch(/^credit:[0-9a-f]{24}$/);
  });

  it("lowercases the owner so lookup matches regardless of checksum casing", async () => {
    await linkCreditOwner(OWNER.toUpperCase().replace("0X", "0x"), `ck_${"c".repeat(36)}`);
    expect(kvMock.kvSAdd.mock.calls[0][0]).toBe(`credit:owner:${OWNER}`);
  });

  it("ignores anything that isn't an address", async () => {
    await linkCreditOwner("not-an-address", `ck_${"d".repeat(36)}`);
    expect(kvMock.kvSAdd).not.toHaveBeenCalled();
  });
});

/**
 * The message is built in two places — the route and the client component — and
 * a signature over a mismatched string verifies as "not yours". That failure is
 * silent and only shows up when a real customer tries to recover, so pin the
 * exact bytes here and round-trip a real signature through viem.
 *
 * These two import the route module and viem at call time, which the runner has
 * to transform first — seconds, not milliseconds, when the whole suite is warming
 * up at once. The default 5s timeout fails them for that alone, so it is raised
 * here: what is being asserted is string equality, not speed.
 */
describe("recovery message + signature round-trip", () => {
  it("produces the exact string both sides must agree on", { timeout: 30_000 }, async () => {
    const { recoveryMessage } = await import("@/app/api/credits/recover/route");
    expect(recoveryMessage("0xABCdef0000000000000000000000000000000001", "2026-07-29T00:00:00.000Z")).toBe(
      [
        "x402 Bazaar — recover credit balance",
        "",
        "Address: 0xabcdef0000000000000000000000000000000001",
        "Issued: 2026-07-29T00:00:00.000Z",
        "",
        "Signing this re-issues your credit token and moves the remaining balance to it.",
        "Any token issued earlier stops working.",
      ].join("\n"),
    );
  });

  it("verifies a signature produced by the paying wallet, and rejects another wallet's", { timeout: 30_000 }, async () => {
    const { recoveryMessage } = await import("@/app/api/credits/recover/route");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { verifyMessage } = await import("viem");

    const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const issuedAt = new Date().toISOString();
    const message = recoveryMessage(owner.address, issuedAt);
    const signature = await owner.signMessage({ message });

    expect(await verifyMessage({ address: owner.address, message, signature })).toBe(true);
    expect(await verifyMessage({ address: stranger.address, message, signature })).toBe(false);
    // A signature over a different timestamp must not authorise this request.
    const otherMessage = recoveryMessage(owner.address, "2020-01-01T00:00:00.000Z");
    expect(await verifyMessage({ address: owner.address, message: otherMessage, signature })).toBe(false);
  });
});
