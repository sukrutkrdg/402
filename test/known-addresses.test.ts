import { describe, it, expect } from "vitest";
import { getAddress } from "viem";
import { KNOWN_ADDRESSES, KNOWN_ADDRESSES_CHECKED_AT, lookupKnown, labelHolder, knownLabel, NON_DUMPABLE } from "@/lib/known-addresses";

/**
 * The registry is only worth anything if every label in it can be traced back
 * to where it was published. These are the rules each entry must meet before
 * it is allowed to change a dump-risk verdict.
 */
describe("known-address registry", () => {
  it("every entry has an https source URL", () => {
    for (const k of KNOWN_ADDRESSES) {
      expect(k.source, `${k.label}`).toMatch(/^https:\/\/[^\s]+\.[a-z]{2,}\//);
    }
  });

  it("every address is valid and EIP-55 checksummed", () => {
    for (const k of KNOWN_ADDRESSES) {
      expect(k.address, k.label).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(getAddress(k.address), `${k.label} is not checksummed`).toBe(k.address);
    }
  });

  it("has no duplicate addresses", () => {
    const lc = KNOWN_ADDRESSES.map((k) => k.address.toLowerCase());
    expect(new Set(lc).size).toBe(lc.length);
  });

  it("a Basescan-sourced entry points at its own address", () => {
    for (const k of KNOWN_ADDRESSES.filter((x) => x.source.startsWith("https://basescan.org/address/"))) {
      expect(k.source.toLowerCase(), k.label).toBe(`https://basescan.org/address/${k.address.toLowerCase()}`);
    }
  });

  it("records the onchain code check: every non-cex, non-burn entry is a contract", () => {
    expect(KNOWN_ADDRESSES_CHECKED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const k of KNOWN_ADDRESSES) {
      if (k.kind !== "cex" && k.kind !== "burn") expect(k.hasCode, `${k.label} must have code on Base`).toBe(true);
    }
  });

  it("stays a curated list, not a dump", () => {
    expect(KNOWN_ADDRESSES.length).toBeGreaterThanOrEqual(40);
    expect(KNOWN_ADDRESSES.length).toBeLessThanOrEqual(100);
  });

  it("looks up case-insensitively and never invents a match", () => {
    expect(lookupKnown("0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb")?.kind).toBe("lending");
    expect(lookupKnown("0x1111111111111111111111111111111111111111")).toBeNull();
    expect(lookupKnown(null)).toBeNull();
  });
});

describe("labelHolder", () => {
  it("Morpho Blue is lending and non-dumpable, with its source", () => {
    const l = labelHolder("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", { isContract: true });
    expect(l.kind).toBe("lending");
    expect(l.nonDumpable).toBe(true);
    expect(l.source).toContain("morpho.org");
  });

  it("an exchange wallet stays dumpable but is labelled as pooled user funds", () => {
    const l = labelHolder("0x7061f0b28f5a95aae717905bb59aa4e08c165268");
    expect(l.kind).toBe("cex");
    expect(l.nonDumpable).toBe(false);
    expect(l.label).toContain("cex (pooled user funds)");
  });

  it("a protocol treasury can sell", () => {
    expect(NON_DUMPABLE.has("protocol-treasury")).toBe(false);
    expect(labelHolder("0x65A633E8E379F9358C389c75ff1D913a92ab95B8").nonDumpable).toBe(false);
  });

  it("an unknown contract stays dumpable and says so", () => {
    const l = labelHolder("0x06a19654e0872ba71c2261ea691ecf8a0c677156", { isContract: true });
    expect(l.kind).toBe("unknown contract");
    expect(l.nonDumpable).toBe(false);
  });

  it("the token's own pair is a dex pool; an ERC-4626 vault for it is a vault", () => {
    const pair = "0xc9034c3e7f58003e6ae0c8438e7c8f4598d5acaa";
    expect(labelHolder(pair, { pairAddresses: new Set([pair]), isContract: true }).kind).toBe("dex pool");
    const vault = "0x00000000000000000000000000000000000000aa";
    const v = labelHolder(vault, { vaultsForToken: new Set([vault]), isContract: true });
    expect(v.kind).toBe("vault");
    expect(v.nonDumpable).toBe(true);
  });

  it("knownLabel is null for an unlisted address", () => {
    expect(knownLabel("0x1111111111111111111111111111111111111111")).toEqual({ label: null, labelKind: null, labelSource: null });
    expect(knownLabel("0x498581ff718922c3f8e6a244956af099b2652b2b").labelKind).toBe("dex");
  });
});
