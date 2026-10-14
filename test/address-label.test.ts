import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * address-label: registry match first, then interface reads. The chain is
 * mocked; what is under test is that a label only comes from the sourced
 * registry or a successful interface read, and that a failed read is "not
 * detected", never a positive.
 */
const state = vi.hoisted(() => ({
  code: "0x" as string,
  reads: {} as Record<string, unknown>,
  rpcDown: false,
}));

vi.mock("viem", async (orig) => {
  const actual = await orig<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getCode: async () => {
        if (state.rpcDown) throw new Error("HTTP request failed");
        return state.code;
      },
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName in state.reads) return state.reads[functionName];
        throw new Error("execution reverted");
      },
    }),
  };
});

import { describeAddress, probeVaultsForToken } from "@/lib/address-probe";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOME = "0x06A19654e0872Ba71c2261EA691ECF8a0C677156";

beforeEach(() => {
  state.code = "0x";
  state.reads = {};
  state.rpcDown = false;
});

describe("address-label", () => {
  it("returns the registry match with its source", async () => {
    state.code = "0x6080";
    const r = await describeAddress({ address: MORPHO.toLowerCase() });
    expect(r.kind).toBe("lending");
    expect(r.known?.source).toMatch(/^https:\/\/docs\.morpho\.org/);
    expect(r.isContract).toBe(true);
  });

  it("a plain EOA is an unlabelled wallet", async () => {
    const r = await describeAddress({ address: "0x1111111111111111111111111111111111111111" });
    expect(r.kind).toBe("eoa");
    expect(r.known).toBeNull();
    expect(r.label).toBe("unlabelled wallet (EOA)");
  });

  it("an EIP-7702 delegated EOA is reported as an EOA with its delegate", async () => {
    state.code = "0xef0100" + "63c0c19a282a1b52b07dd5a65b58948a07dae32b";
    const r = await describeAddress({ address: "0x1111111111111111111111111111111111111111" });
    expect(r.isContract).toBe(false);
    expect(r.kind).toBe("eoa (EIP-7702 delegated)");
  });

  it("detects an ERC-4626 vault and a Safe from interface reads", async () => {
    state.code = "0x6080";
    state.reads = { asset: USDC, symbol: "USDC" };
    const v = await describeAddress({ address: SOME });
    expect(v.kind).toBe("vault");
    expect(v.erc4626?.assetSymbol).toBe("USDC");

    state.reads = { getThreshold: 2n };
    const s = await describeAddress({ address: SOME });
    expect(s.kind).toBe("multisig");
    expect(s.label).toBe("Safe multisig (2-of-N)");
  });

  it("an unreadable contract stays an unknown contract", async () => {
    state.code = "0x6080";
    const r = await describeAddress({ address: SOME });
    expect(r.kind).toBe("unknown contract");
    expect(r.detected).toEqual([]);
  });

  it("an RPC outage throws (not charged) rather than answering 'EOA'", async () => {
    state.rpcDown = true;
    await expect(describeAddress({ address: SOME })).rejects.toThrow(/not charged/);
  });

  it("probeVaultsForToken only accepts vaults whose asset() is this token", async () => {
    state.reads = { asset: USDC };
    expect([...(await probeVaultsForToken(USDC, [SOME]))]).toEqual([SOME.toLowerCase()]);
    expect([...(await probeVaultsForToken("0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", [SOME]))]).toEqual([]);
  });
});
