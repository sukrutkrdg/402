import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { classifyCode } from "../src/lib/primitives";

/**
 * "Has code" is no longer the same as "is a contract".
 *
 * Under EIP-7702 a plain wallet can delegate to an implementation, and what it
 * leaves on chain is a 23-byte designator: `0xef0100` followed by the delegate's
 * address. The account still signs and sends its own transactions.
 *
 * That distinction decides what a nonce MEANS. `eth_getTransactionCount` returns
 * transactions sent for an account that signs, and contracts created for a
 * contract — the same integer under two different meanings. Classifying a
 * delegated wallet as a contract reports "1,326 contracts deployed" for someone
 * who has simply sent 1,326 transactions, and nothing about the response looks
 * wrong. Our own treasury is delegated, which is how this was found: the first
 * version of these endpoints got it backwards on the first address we tried.
 */

const DELEGATE = "0x36d3CBD83961868398d056EfBf50f5CE15528c0D";
/** The real designator shape: 0xef0100 ++ 20-byte address = 23 bytes. */
const DELEGATION_CODE = `0xef0100${DELEGATE.slice(2).toLowerCase()}`;

describe("classifyCode", () => {
  it("reads a 7702 designator as a wallet, and names the delegate", () => {
    const k = classifyCode(DELEGATION_CODE);
    expect(k.isContract, "a 7702 designator is not a contract").toBe(false);
    // The delegate address is the actionable half — without it a caller cannot
    // find out what the wallet is now able to do.
    expect(k.delegatedTo).toBe(DELEGATE);
    expect(k.codeSize).toBe(23);
  });

  it("reads an empty account as a wallet", () => {
    for (const empty of ["0x", undefined]) {
      const k = classifyCode(empty);
      expect(k.isContract).toBe(false);
      expect(k.delegatedTo).toBeNull();
      expect(k.codeSize).toBe(0);
    }
  });

  it("reads real bytecode as a contract", () => {
    const k = classifyCode(`0x60806040${"ab".repeat(200)}`);
    expect(k.isContract).toBe(true);
    expect(k.delegatedTo).toBeNull();
  });

  it("does not mistake a 23-byte contract for a delegation", () => {
    // Same length, wrong prefix. Length alone must not be the test.
    const k = classifyCode(`0x60${"11".repeat(22)}`);
    expect(k.codeSize).toBe(23);
    expect(k.isContract).toBe(true);
    expect(k.delegatedTo).toBeNull();
  });

  it("matches the prefix case-insensitively", () => {
    // Nodes are not consistent about hex casing, and a case-sensitive check
    // would classify the same account differently depending on the provider.
    expect(classifyCode(`0xEF0100${DELEGATE.slice(2).toUpperCase()}`).delegatedTo).toBe(DELEGATE);
  });
});

/**
 * And the wiring: that the classification actually reaches the reported fields.
 * The network is stubbed because the point is the mapping, not the chain — and a
 * real 7702 wallet can un-delegate at any time, which would make a live-address
 * test go quietly green for the wrong reason.
 */
function stubChain(code: string, nonce: number) {
  vi.doMock("viem", async (orig) => {
    const actual = (await orig()) as Record<string, unknown>;
    return {
      ...actual,
      createPublicClient: () => ({
        getCode: async () => (code === "0x" ? undefined : code),
        getTransactionCount: async () => nonce,
        getBalance: async () => 0n,
      }),
    };
  });
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.doUnmock("viem"));

describe("base-nonce reports the count under the right name", () => {
  it("delegated wallet: transactions sent, never deployments", async () => {
    stubChain(DELEGATION_CODE, 1326);
    const { baseNonce } = await import("../src/lib/primitives");
    const r = (await baseNonce({ address: DELEGATE })) as Record<string, unknown>;
    expect(r.sentTransactions, "the nonce counts transactions here").toBe(1326);
    expect(r.contractsDeployed, "and must NOT be reported as deployments").toBeNull();
    expect(r.delegated).toBe(true);
  }, 30_000);

  it("contract: deployments, never transactions sent", async () => {
    stubChain(`0x60806040${"ab".repeat(200)}`, 1);
    const { baseNonce } = await import("../src/lib/primitives");
    const r = (await baseNonce({ address: DELEGATE })) as Record<string, unknown>;
    expect(r.contractsDeployed).toBe(1);
    expect(r.sentTransactions).toBeNull();
  }, 30_000);
});
