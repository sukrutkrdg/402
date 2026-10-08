import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * dump-risk: exit-liquidity. Values the largest LIVE holder's bag (% of supply ×
 * market cap) and dumps it through aggregate liquidity with the same conservative
 * constant-product math price-impact uses. GoPlus + DexScreener mocked so the
 * dumpable-holder selection and impact math are what's under test.
 */
const { ucMock } = vi.hoisted(() => ({
  ucMock: { goPlusSecurity: vi.fn(), dexTokenPairs: vi.fn() },
}));
vi.mock("@/lib/upstream-cache", () => ucMock);

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

  it("does not charge when both sources are down", async () => {
    ucMock.goPlusSecurity.mockResolvedValue(null);
    ucMock.dexTokenPairs.mockResolvedValue(null);
    await expect(dumpRisk({ address: TOKEN })).rejects.toThrow(/not charged/);
  });
});
