/**
 * The general validity-transaction builder. buildValidityPredicates is pinned in
 * base-swap-validity.test.ts; this covers what validity-build adds — the signed-tx
 * passthrough/validation and the JSON-RPC envelope shape.
 */

import { describe, it, expect } from "vitest";
import { validityBuild } from "@/lib/validity-tx";

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

  it("flags the missing deadline in steps when only a non-deadline condition is set", async () => {
    const r = await validityBuild({ flashblockIndex: "0" });
    expect(r.steps.join(" ")).toMatch(/beforeBlock deadline/i);
  });
});
