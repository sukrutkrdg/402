/**
 * Commodity utils: deterministic, so pin them against known vectors — especially
 * unit-convert, which shipped with an inverted scale bug caught in live testing
 * (1.5 ether → wei returned "1" instead of 1.5e18).
 */

import { describe, it, expect } from "vitest";
import { hashUtil, unitConvert, ping } from "@/lib/compute-utils";

describe("hash", () => {
  it("keccak256 of the ERC-20 Transfer signature is the canonical topic", async () => {
    const r = await hashUtil({ input: "Transfer(address,address,uint256)" });
    expect(r.hash).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(r.selector).toBe("0xddf252ad");
  });
  it("sha256 differs and is selected by algo", async () => {
    const r = await hashUtil({ input: "abc", algo: "sha256" });
    expect(r.algo).toBe("sha256");
    expect(r.hash).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); // sha256("abc")
  });
  it("rejects empty input", async () => {
    await expect(hashUtil({ input: "" })).rejects.toThrow(/input/i);
  });
});

describe("unit-convert", () => {
  it("1.5 ether → wei is 1.5e18 (the bug that shipped)", async () => {
    const r = await unitConvert({ amount: "1.5", from: "ether", to: "wei" });
    expect(r.result).toBe("1500000000000000000");
  });
  it("1.5 ether → gwei", async () => {
    expect((await unitConvert({ amount: "1.5", from: "ether", to: "gwei" })).result).toBe("1500000000");
  });
  it("1000 wei → ether", async () => {
    expect((await unitConvert({ amount: "1000", from: "wei", to: "ether" })).result).toBe("0.000000000000001");
  });
  it("accepts raw decimals numbers (USDC 6)", async () => {
    expect((await unitConvert({ amount: "100", from: "6", to: "0" })).result).toBe("100000000");
  });
  it("rejects an unknown unit", async () => {
    await expect(unitConvert({ amount: "1", from: "ether", to: "satoshi" })).rejects.toThrow(/unknown unit/i);
  });
});

describe("ping", () => {
  it("always returns ok and echoes", async () => {
    const r = await ping({ echo: "hi" });
    expect(r.ok).toBe(true);
    expect(r.echo).toBe("hi");
  });
});
