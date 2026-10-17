import { describe, it, expect } from "vitest";
import { balanceSlotKey, candidateLayouts } from "@/lib/liquidity-guard";

describe("liquidity guard storage keys", () => {
  it("computes the Solidity mapping key exactly as measured on Base", () => {
    // USDC (FiatToken, balances at slot 9) for the AERO/USDC Aerodrome pool,
    // proven against balanceOf on mainnet on 2026-10-17.
    expect(balanceSlotKey("0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d", { kind: "solidity", slot: "0x9" })).toBe(
      "0x7348fbab97c2c4138d858614c0c1b88b55c0f329ba0480a599677abd22b84464",
    );
    // WETH9 predeploy, balanceOf at slot 3, DEGEN/WETH pool.
    expect(balanceSlotKey("0x0cA6485b7e9cF814A3Fd09d81672B07323535b64", { kind: "solidity", slot: "0x3" })).toBe(
      "0x19abcfb40ef5f24b4af7fd23b31d58d9415a3a926cb1df93f06c6ced41f8e655",
    );
  });

  it("hashes Vyper mappings in the reverse order", () => {
    const h = "0x0cA6485b7e9cF814A3Fd09d81672B07323535b64";
    expect(balanceSlotKey(h, { kind: "vyper", slot: "0x3" })).not.toBe(balanceSlotKey(h, { kind: "solidity", slot: "0x3" }));
  });

  it("probes Solidity, Vyper and OpenZeppelin 5 namespaced layouts", () => {
    const kinds = new Set(candidateLayouts().map((l) => l.kind));
    expect([...kinds].sort()).toEqual(["oz5", "solidity", "vyper"]);
  });
});
