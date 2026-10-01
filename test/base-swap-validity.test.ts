/**
 * The predicate builder for Cobalt validity swaps. It is pure and the one piece
 * that MUST be exact: a wrong operator, an un-encoded value, or an empty array
 * all produce a transaction that fires at the wrong moment or is rejected. So
 * every predicate shape, the operator whitelist, hex encoding, and the refusal
 * of a condition-free "conditional" swap are pinned here.
 */

import { describe, it, expect } from "vitest";
import { buildValidityPredicates, toHexQuantity } from "@/lib/base-swap-validity";

const TAKER = "0x1234567890abcdef1234567890abcdef12345678";

describe("validity predicate builder", () => {
  it("encodes a decimal deadline as a minimal hex block_number with op <", () => {
    const p = buildValidityPredicates({ beforeBlock: "1157000" });
    expect(p).toEqual([{ type: "block_number", params: { op: "<", value: "0x11a788" } }]);
  });

  it("accepts an already-hex value and a fromBlock lower bound", () => {
    const p = buildValidityPredicates({ beforeBlock: "0x11a788", fromBlock: "1156000" });
    expect(p[0]).toEqual({ type: "block_number", params: { op: "<", value: "0x11a788" } });
    expect(p[1]).toEqual({ type: "block_number", params: { op: ">=", value: "0x11a3a0" } });
  });

  it("pins a flashblock index, defaulting the operator to =", () => {
    expect(buildValidityPredicates({ flashblockIndex: "0" })).toEqual([
      { type: "flashblock_index", params: { op: "=", value: "0x0" } },
    ]);
  });

  it("builds a native balance floor against the taker by default", () => {
    const p = buildValidityPredicates({ minNativeBalanceWei: "1000000000000000000", taker: TAKER });
    expect(p).toEqual([{ type: "balance", params: { address: TAKER, op: ">=", value: "0xde0b6b3a7640000" } }]);
  });

  it("forwards a complete, caller-supplied storage predicate with a mask", () => {
    const p = buildValidityPredicates({
      storageAddress: "0x8ba1f109551bd432803012645ac136ddd64dba72",
      storageSlot: "0x8",
      storageOp: ">=",
      storageValue: "0x2a",
      storageMask: "0xff",
    });
    expect(p).toEqual([
      {
        type: "storage",
        params: { address: "0x8ba1f109551bd432803012645ac136ddd64dba72", slot: "0x8", op: ">=", value: "0x2a", mask: "0xff" },
      },
    ]);
  });

  it("honours a custom operator on the flashblock index", () => {
    expect(buildValidityPredicates({ flashblockIndex: "3", flashblockIndexOp: "<=" })).toEqual([
      { type: "flashblock_index", params: { op: "<=", value: "0x3" } },
    ]);
  });

  it("refuses a 'conditional' swap with no condition at all", () => {
    expect(() => buildValidityPredicates({})).toThrow(/at least one condition/i);
  });

  it("treats a lone storageMask as an incomplete storage predicate, not a no-op", () => {
    // All-or-nothing: a mask with no slot/address/op/value must error on the
    // missing field, not silently vanish and report "no condition".
    expect(() => buildValidityPredicates({ storageMask: "0xff" })).toThrow(/storageAddress/i);
  });

  it("rejects a storage predicate missing its operator", () => {
    expect(() =>
      buildValidityPredicates({ storageAddress: "0x8ba1f109551bd432803012645ac136ddd64dba72", storageSlot: "0x8", storageValue: "0x2a" }),
    ).toThrow(/operator|< <= =/i);
  });

  it("rejects an operator outside the whitelist", () => {
    expect(() => buildValidityPredicates({ storageAddress: "0x8ba1f109551bd432803012645ac136ddd64dba72", storageSlot: "0x8", storageOp: "===", storageValue: "0x2a" })).toThrow(/operator|< <= =/i);
  });

  it("rejects a partial storage predicate (slot without the rest)", () => {
    expect(() => buildValidityPredicates({ storageSlot: "0x8" })).toThrow(/storageAddress/i);
  });

  it("rejects a non-integer quantity and a negative one", () => {
    expect(() => toHexQuantity("12.5", "beforeBlock")).toThrow(/non-negative integer/i);
    expect(() => toHexQuantity("-1", "beforeBlock")).toThrow(/non-negative/i);
  });

  it("encodes zero as 0x0 and requires a value", () => {
    expect(toHexQuantity("0", "x")).toBe("0x0");
    expect(toHexQuantity("0x0", "x")).toBe("0x0");
    expect(() => toHexQuantity("", "x")).toThrow(/required/i);
    expect(() => toHexQuantity(undefined, "x")).toThrow(/required/i);
    expect(() => toHexQuantity("   ", "x")).toThrow(/required/i);
  });
});
