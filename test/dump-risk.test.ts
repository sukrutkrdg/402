import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * dump-risk: exit-liquidity. Values the largest LIVE holder's bag (% of supply ×
 * market cap) and dumps it through aggregate liquidity with the same conservative
 * constant-product math price-impact uses. GoPlus + DexScreener mocked so the
 * dumpable-holder selection and impact math are what's under test.
 */
const { ucMock, probeMock } = vi.hoisted(() => ({
  ucMock: { goPlusSecurity: vi.fn(), dexTokenPairs: vi.fn() },
  probeMock: { probeVaultsForToken: vi.fn() },
}));
vi.mock("@/lib/upstream-cache", () => ucMock);
vi.mock("@/lib/address-probe", () => probeMock);

import { dumpRisk } from "@/lib/dump-risk";

const TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";

function gp(holders: Array<{ address: string; percent: string; tag?: string; is_locked?: number; is_contract?: number }>) {
  return { holder_count: 1234, holders };
}
function dex(liquidityUsd: number, marketCap: number) {
  return [{ baseToken: { address: TOKEN.toLowerCase() }, priceUsd: "0.01", liquidity: { usd: liquidityUsd }, marketCap }];
}

beforeEach(() => {
  ucMock.goPlusSecurity.mockReset();
  ucMock.dexTokenPairs.mockReset();
  probeMock.probeVaultsForToken.mockReset();
  probeMock.probeVaultsForToken.mockResolvedValue(new Set());
});

describe("dump-risk — known holders", () => {
  const MORPHO = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
  const BITHUMB = "0x7061f0b28f5a95aae717905bb59aa4e08c165268";
  const UNKNOWN_CONTRACT = "0x06a19654e0872ba71c2261ea691ecf8a0c677156";
  const PAIR = "0xc9034c3e7f58003e6ae0c8438e7c8f4598d5acaa";

  it("a lending market (Morpho Blue) holding 30% is not the whale that makes it an exit_trap", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(
      gp([
        { address: MORPHO, percent: "0.30", is_contract: 1 },
        { address: "0xaaa", percent: "0.01" },
      ]),
    );
    ucMock.dexTokenPairs.mockResolvedValue(dex(300_000, 5_000_000)); // 30% would be 1.5M into 150k reserve
    const r = await dumpRisk({ address: TOKEN });
    expect(r.verdict).not.toBe("exit_trap");
    expect(r.topDumpableHolder?.address).toBe("0xaaa");
    const ex = r.excludedAsNonDumpable.find((h) => h.address === MORPHO);
    expect(ex?.kind).toBe("lending");
    expect(ex?.label).toMatch(/Morpho/);
    expect(ex?.source).toMatch(/^https:\/\//);
    expect(ex?.reason).toMatch(/lending/);
  });

  it("an exchange wallet stays dumpable but is labelled and reported separately, not as the top holder", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(
      gp([
        { address: BITHUMB, percent: "0.11" },
        { address: "0xaaa", percent: "0.02" },
      ]),
    );
    ucMock.dexTokenPairs.mockResolvedValue(dex(2_000_000, 1_000_000));
    const r = await dumpRisk({ address: TOKEN });
    expect(r.excludedAsNonDumpable.find((h) => h.address === BITHUMB)).toBeUndefined();
    expect(r.cexHolders).toHaveLength(1);
    expect(r.cexHolders[0].label).toContain("cex (pooled user funds)");
    expect(r.cexConcentrationPct).toBe(11);
    expect(r.topDumpableHolder?.address).toBe("0xaaa");
    expect(r.holderLabels.find((h) => h.address === BITHUMB)?.dumpable).toBe(true);
    expect(r.recommendation).toMatch(/Exchange wallets hold 11%/);
  });

  it("an unknown contract stays dumpable, labelled 'unknown contract'", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(gp([{ address: UNKNOWN_CONTRACT, percent: "0.30", is_contract: 1 }]));
    ucMock.dexTokenPairs.mockResolvedValue(dex(300_000, 5_000_000));
    const r = await dumpRisk({ address: TOKEN });
    expect(r.topDumpableHolder?.address).toBe(UNKNOWN_CONTRACT);
    expect(r.topDumpableHolder?.label).toBe("unknown contract");
    expect(r.verdict).toBe("exit_trap");
    // It was probed as a possible vault, and the failed/negative probe kept it dumpable.
    expect(probeMock.probeVaultsForToken).toHaveBeenCalledWith(TOKEN, [UNKNOWN_CONTRACT]);
  });

  it("one of the token's own DEX pairs is excluded as the pool, even untagged", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(
      gp([
        { address: PAIR, percent: "0.40", is_contract: 1 },
        { address: "0xaaa", percent: "0.01" },
      ]),
    );
    ucMock.dexTokenPairs.mockResolvedValue([
      { pairAddress: PAIR, baseToken: { address: TOKEN.toLowerCase() }, priceUsd: "0.01", liquidity: { usd: 2_000_000 }, marketCap: 1_000_000 },
    ]);
    const r = await dumpRisk({ address: TOKEN });
    const ex = r.excludedAsNonDumpable.find((h) => h.address === PAIR);
    expect(ex?.kind).toBe("dex pool");
    expect(r.topDumpableHolder?.address).toBe("0xaaa");
    expect(probeMock.probeVaultsForToken).not.toHaveBeenCalled();
  });

  it("a contract confirmed as an ERC-4626 vault for this token is excluded", async () => {
    probeMock.probeVaultsForToken.mockResolvedValue(new Set([UNKNOWN_CONTRACT]));
    ucMock.goPlusSecurity.mockResolvedValue(
      gp([
        { address: UNKNOWN_CONTRACT, percent: "0.30", is_contract: 1 },
        { address: "0xaaa", percent: "0.01" },
      ]),
    );
    ucMock.dexTokenPairs.mockResolvedValue(dex(2_000_000, 1_000_000));
    const r = await dumpRisk({ address: TOKEN });
    expect(r.excludedAsNonDumpable.find((h) => h.address === UNKNOWN_CONTRACT)?.kind).toBe("vault");
  });

  it("a failed vault probe leaves the contract dumpable", async () => {
    probeMock.probeVaultsForToken.mockRejectedValue(new Error("rpc down"));
    ucMock.goPlusSecurity.mockResolvedValue(gp([{ address: UNKNOWN_CONTRACT, percent: "0.30", is_contract: 1 }]));
    ucMock.dexTokenPairs.mockResolvedValue(dex(300_000, 5_000_000));
    const r = await dumpRisk({ address: TOKEN });
    expect(r.topDumpableHolder?.address).toBe(UNKNOWN_CONTRACT);
  });
});

describe("dump-risk", () => {
  it("resilient when the biggest live holder is tiny vs liquidity", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(gp([{ address: "0xaaa", percent: "0.02" }])); // 2% of supply
    ucMock.dexTokenPairs.mockResolvedValue(dex(2_000_000, 1_000_000)); // bag=20k, reserve=1M
    const r = await dumpRisk({ address: TOKEN });
    // 20000/(1,000,000+20,000) ≈ 1.96%
    expect(r.topHolderDumpImpactPct).toBeLessThan(5);
    expect(r.verdict).toBe("resilient");
  });

  it("exit_trap when a whale's bag dwarfs the pool", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(gp([{ address: "0xaaa", percent: "0.30" }])); // 30%
    ucMock.dexTokenPairs.mockResolvedValue(dex(300_000, 5_000_000)); // bag=1.5M, reserve=150k
    const r = await dumpRisk({ address: TOKEN });
    // 1,500,000/(150,000+1,500,000) ≈ 91%
    expect(r.topHolderDumpImpactPct).toBeGreaterThan(50);
    expect(r.verdict).toBe("exit_trap");
  });

  it("excludes pool / locked / burn holders as non-dumpable", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(
      gp([
        { address: "0xpool", percent: "0.50", tag: "Uniswap V3" },
        { address: "0x000000000000000000000000000000000000dead", percent: "0.20" },
        { address: "0xlocked", percent: "0.15", is_locked: 1 },
        { address: "0xwhale", percent: "0.05" },
      ]),
    );
    ucMock.dexTokenPairs.mockResolvedValue(dex(1_000_000, 1_000_000));
    const r = await dumpRisk({ address: TOKEN });
    expect(r.topDumpableHolder?.address).toBe("0xwhale");
    expect(r.excludedAsNonDumpable.length).toBe(3);
  });

  it("no_liquidity when there is no pool", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(gp([{ address: "0xaaa", percent: "0.10" }]));
    ucMock.dexTokenPairs.mockResolvedValue([]);
    const r = await dumpRisk({ address: TOKEN });
    expect(r.verdict).toBe("no_liquidity");
  });

  it("unknown when no market cap is available to value the bag", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(gp([{ address: "0xaaa", percent: "0.10" }]));
    ucMock.dexTokenPairs.mockResolvedValue([{ baseToken: { address: TOKEN.toLowerCase() }, priceUsd: "0.01", liquidity: { usd: 500_000 } }]);
    const r = await dumpRisk({ address: TOKEN });
    expect(r.verdict).toBe("unknown");
    expect(r.topHolderDumpImpactPct).toBeNull();
  });

  it("a DexScreener outage is not 'no liquidity' — throws, not charged", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(gp([{ address: "0xaaa", percent: "0.10" }]));
    ucMock.dexTokenPairs.mockResolvedValue(null);
    await expect(dumpRisk({ address: TOKEN })).rejects.toThrow(/DexScreener.*not charged/);
  });

  it("does not charge when both sources are down", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(null);
    ucMock.dexTokenPairs.mockResolvedValue(null);
    await expect(dumpRisk({ address: TOKEN })).rejects.toThrow(/not charged/);
  });
});
