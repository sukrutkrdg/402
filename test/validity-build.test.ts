/**
 * The general validity-transaction builder. buildValidityPredicates is pinned in
 * base-swap-validity.test.ts; this covers what validity-build adds — the signed-tx
 * passthrough/validation, the JSON-RPC envelope shape, and Base's deadline rule
 * (an upper bound is required and must be within 60 s of submission).
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
    const r = await validityBuild({ beforeBlock: "1000020" });
    expect(r.signedTxProvided).toBe(false);
    expect(r.submit.method).toBe("base_sendRawTransactionValidity");
    expect(r.submit.rpcRequest.params[0]).toBe("0x<SIGNED_RAW_TRANSACTION>");
    expect(r.submit.rpcRequest.params[1]).toEqual({ validity: [{ type: "block_number", params: { op: "<", value: "0xf4254" } }] });
    expect(r.conditionCount).toBe(1);
    expect(r.expiresInSeconds).toBe(40);
  });

  it("embeds a provided signed tx, lowercased", async () => {
    const r = await validityBuild({ beforeBlock: "1000020", signedTx: "0xDEADBEEF" });
    expect(r.signedTxProvided).toBe(true);
    expect(r.submit.rpcRequest.params[0]).toBe("0xdeadbeef");
  });

  it("refuses a malformed signed tx (odd length / non-hex)", async () => {
    await expect(validityBuild({ beforeBlock: "1000020", signedTx: "0xABC" })).rejects.toThrow(/signedTx/i);
    await expect(validityBuild({ beforeBlock: "1000020", signedTx: "nothex" })).rejects.toThrow(/signedTx/i);
  });

  it("sets the required deadline itself when none is given", async () => {
    const r = await validityBuild({});
    expect(r.deadlineAutoSet).toBe(true);
    expect(r.validity).toEqual([{ type: "block_number", params: { op: "<", value: `0x${(1_000_025).toString(16)}` } }]);
    expect(r.steps.join(" ")).toMatch(/none was given, so we set one/);
  });

  it("refuses a deadline that has already passed, naming the current block", async () => {
    await expect(validityBuild({ beforeBlock: "999999" })).rejects.toThrow(/already passed.*1000000/);
    await expect(validityBuild({ beforeBlock: "1000000" })).rejects.toThrow(/already passed/);
  });

  it("refuses a deadline more than 60 s out (Base's rule), naming the furthest allowed block", async () => {
    await expect(validityBuild({ beforeBlock: "1000032" })).rejects.toThrow(/within 60 s.*1000031/);
    await expect(validityBuild({ beforeBlock: "999999999" })).rejects.toThrow(/within 60 s/);
    const r = await validityBuild({ beforeBlock: "1000031" });
    expect(r.deadlineChecked).toBe(true);
  });

  it("forwards a given deadline unchecked when the chain cannot be read, and says so", async () => {
    chain.fail = true;
    try {
      const r = await validityBuild({ beforeBlock: "999999" });
      expect(r.deadlineChecked).toBe(false);
      expect(r.currentBlock).toBeNull();
    } finally {
      chain.fail = false;
    }
  });

  it("fails as an outage, not a build without a deadline, when none is given and the chain is down", async () => {
    chain.fail = true;
    try {
      await expect(validityBuild({})).rejects.toThrow(/retry shortly/);
    } finally {
      chain.fail = false;
    }
  });

  it("reports the block it checked against", async () => {
    const r = await validityBuild({ beforeBlock: "1000020" });
    expect(r.deadlineChecked).toBe(true);
    expect(r.currentBlock).toBe("1000000");
  });

  it("adds the deadline alongside a flashblock condition", async () => {
    const r = await validityBuild({ flashblockIndex: "2" });
    expect(r.validity.map((v) => v.type)).toEqual(["block_number", "flashblock_index"]);
  });
});
