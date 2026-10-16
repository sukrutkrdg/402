/**
 * The general validity-transaction builder. buildValidityPredicates is pinned in
 * base-swap-validity.test.ts; this covers what validity-build adds — the signed-tx
 * passthrough/validation and the JSON-RPC envelope shape.
 */

import { describe, it, expect, vi } from "vitest";

// The deadline check reads Base's current block. Pin it, so the tests never hit
// the network and the "already passed" case is deterministic.
const chain = vi.hoisted(() => ({ block: 1_000_000n, fail: false }));
vi.mock("viem", async (orig) => ({
  ...(await orig<typeof import("viem")>()),
  createPublicClient: () => ({
    getBlockNumber: async () => {
      if (chain.fail) throw new Error("rpc down");
      return chain.block;
    },
  }),
}));

const { validityBuild } = await import("@/lib/validity-tx");

describe("validity-build", () => {
  it("returns a placeholder envelope when no signedTx is given", async () => {
    const r = await validityBuild({ beforeBlock: "1157000" });
    expect(r.signedTxProvided).toBe(false);
    expect(r.submit.method).toBe("base_sendRawTransactionValidity");
    expect(r.submit.rpcRequest.params[0]).toBe("0x<SIGNED_RAW_TRANSACTION>");
    expect(r.submit.rpcRequest.params[1]).toEqual({ validity: [{ type: "block_number", params: { op: "<", value: "0x11a788" } }] });
    expect(r.conditionCount).toBe(1);
  });

  it("embeds a provided signed tx, lowercased", async () => {
    const r = await validityBuild({ beforeBlock: "1157000", signedTx: "0xDEADBEEF" });
    expect(r.signedTxProvided).toBe(true);
    expect(r.submit.rpcRequest.params[0]).toBe("0xdeadbeef");
  });

  it("refuses a malformed signed tx (odd length / non-hex)", async () => {
    await expect(validityBuild({ beforeBlock: "1157000", signedTx: "0xABC" })).rejects.toThrow(/signedTx/i);
    await expect(validityBuild({ beforeBlock: "1157000", signedTx: "nothex" })).rejects.toThrow(/signedTx/i);
  });

  it("refuses a build with no condition at all (shares the swap builder's guard)", async () => {
    await expect(validityBuild({})).rejects.toThrow(/at least one condition/i);
  });

  it("refuses a deadline that has already passed, naming the current block", async () => {
    await expect(validityBuild({ beforeBlock: "999999" })).rejects.toThrow(/already passed.*1000000/);
    await expect(validityBuild({ beforeBlock: "1000000" })).rejects.toThrow(/already passed/);
  });

  it("builds anyway when the chain cannot be read, and says the deadline went unchecked", async () => {
    chain.fail = true;
    try {
      const r = await validityBuild({ beforeBlock: "999999" });
      expect(r.deadlineChecked).toBe(false);
      expect(r.currentBlock).toBeNull();
    } finally {
      chain.fail = false;
    }
  });

  it("reports the block it checked against", async () => {
    const r = await validityBuild({ beforeBlock: "1157000" });
    expect(r.deadlineChecked).toBe(true);
    expect(r.currentBlock).toBe("1000000");
  });

  it("flags the missing deadline in steps when only a non-deadline condition is set", async () => {
    const r = await validityBuild({ flashblockIndex: "0" });
    expect(r.steps.join(" ")).toMatch(/beforeBlock deadline/i);
  });
});
