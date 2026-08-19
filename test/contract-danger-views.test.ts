import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A getter is not a power.
 *
 * The scanner matched function NAMES anywhere in the string, against the full
 * ABI. So an ordinary OpenZeppelin token tripped it on `paused()`,
 * `MINTER_ROLE()`, `maxWallet()`, `isBot(address)` and `launchTime()` — every
 * one of them a `view` that cannot change anything, several of them the exact
 * getters a careful contract exposes so you CAN check it. The endpoint sells a
 * safety verdict, so a false "critical" is not a cosmetic bug: it tells someone
 * to avoid a contract that is fine, and it trains them to ignore the next one.
 *
 * Two rules follow. Reads are excluded before matching. And the patterns anchor
 * to the start of the name, because Solidity verbs lead — `setFee`, `mintTo`,
 * `enableTrading` — so `launchTime` no longer reads as `launch`.
 */
const { abiMock } = vi.hoisted(() => ({ abiMock: { contractAbi: vi.fn() } }));
vi.mock("@/lib/onchain-extra3", () => abiMock);

import { contractDanger } from "@/lib/contract-danger";

const ADDR = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

/** Shape contractAbi returns: every function, plus the state-changing subset. */
const abiOf = (all: string[], writes: string[]) =>
  abiMock.contractAbi.mockResolvedValue({
    address: ADDR,
    verified: true,
    matchType: "full",
    functions: all,
    writeFunctions: writes,
    abiItemCount: all.length,
  });

beforeEach(() => vi.clearAllMocks());

describe("read-only functions are never dangers", () => {
  it("clears a token whose only alarming names are getters", async () => {
    const reads = ["paused", "MINTER_ROLE", "maxWallet", "maxTxAmount", "isBot", "launchTime", "totalSupply"];
    abiOf([...reads, "transfer", "approve"], ["transfer", "approve"]);

    const r = (await contractDanger({ address: ADDR })) as Record<string, unknown>;
    expect(r.dangerLevel, "every match was a view").toBe("low");
    expect(r.dangerCount).toBe(0);
  });

  it("still catches the same names when they can actually change state", async () => {
    abiOf(["pause", "setFee", "upgradeTo"], ["pause", "setFee", "upgradeTo"]);
    const r = (await contractDanger({ address: ADDR })) as Record<string, unknown>;
    expect(r.dangerLevel).toBe("critical");
    expect(r.dangerCategories).toEqual(expect.arrayContaining(["pause", "tax", "upgrade"]));
  });

  it("requires the verb to be a whole token, not a prefix of a longer word", async () => {
    // The /i flag made `[A-Z]` match lowercase too, so every boundary pattern
    // quietly degraded to a bare prefix match and these all scored.
    abiOf(["minter", "mintingFinished", "pausable", "frozenAt", "launchTime"], [
      "minter",
      "mintingFinished",
      "pausable",
      "frozenAt",
      "launchTime",
    ]);
    const r = (await contractDanger({ address: ADDR })) as Record<string, unknown>;
    expect(r.dangerCount, `matched: ${JSON.stringify(r.dangerCategories)}`).toBe(0);
  });

  it("still matches the verb when a new token follows it", async () => {
    abiOf(["mintTo", "_mint", "setFeeRate"], ["mintTo", "_mint", "setFeeRate"]);
    const r = (await contractDanger({ address: ADDR })) as Record<string, unknown>;
    expect(r.dangerCategories).toEqual(expect.arrayContaining(["mint", "tax"]));
  });

  it("counts writes separately from the whole ABI", async () => {
    abiOf(["a", "b", "c", "d"], ["a", "b"]);
    const r = (await contractDanger({ address: ADDR })) as Record<string, unknown>;
    expect(r.functionCount).toBe(4);
    expect(r.writeFunctionCount).toBe(2);
  });
});

describe("the verdict does not claim access control it never read", () => {
  it("says outright that the ABI does not show who may call these", async () => {
    abiOf(["mint"], ["mint"]);
    const r = (await contractDanger({ address: ADDR })) as Record<string, unknown>;
    expect(r.accessControlVisible).toBe(false);
    expect(String(r.note)).toMatch(/does not reveal access control/i);
  });

  it("states the condition instead of asserting the owner has the power", async () => {
    // `withdraw()` on a staking contract is how holders get their OWN money
    // out, and from an ABI it is indistinguishable from an owner drain.
    abiOf(["withdraw"], ["withdraw"]);
    const r = (await contractDanger({ address: ADDR })) as { dangers: Array<{ why: string }> };
    const why = r.dangers[0].why;
    expect(why, "no bare 'Owner can' claim").not.toMatch(/^Owner can/);
    expect(why).toMatch(/legitimate way holders withdraw|owner-only/i);
  });
});

describe("an unverified contract is unchanged", () => {
  it("still reports high danger and no findings", async () => {
    abiMock.contractAbi.mockResolvedValue({ address: ADDR, verified: false, functions: [], writeFunctions: [] });
    const r = (await contractDanger({ address: ADDR })) as Record<string, unknown>;
    expect(r.verified).toBe(false);
    expect(r.dangerLevel).toBe("high");
  });
});
