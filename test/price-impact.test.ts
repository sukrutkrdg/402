import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * price-impact: the pre-trade sizing read. The math is constant-product executed-
 * vs-spot loss size/(reserve+size), where reserve ≈ half the pool's USD liquidity.
 * DexScreener is mocked so the AMM math is what's under test.
 */
const { ucMock } = vi.hoisted(() => ({ ucMock: { dexTokenPairs: vi.fn() } }));
vi.mock("@/lib/upstream-cache", () => ucMock);

import { priceImpact } from "@/lib/price-impact";

const TOKEN = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed";

function pool(liquidityUsd: number) {
  return [
    {
      dexId: "aerodrome",
      pairAddress: "0xpool",
      baseToken: { address: TOKEN, symbol: "DEGEN" },
      quoteToken: { symbol: "WETH" },
      priceUsd: "0.01",
      liquidity: { usd: liquidityUsd },
      volume: { h24: 100000 },
    },
  ];
}

beforeEach(() => ucMock.dexTokenPairs.mockReset());

describe("price-impact", () => {
  it("small size vs deep pool is negligible", async () => {
    ucMock.dexTokenPairs.mockResolvedValue(pool(1_000_000)); // reserve 500k
    const r = await priceImpact({ address: TOKEN, size: "1000" });
    // 1000/(500000+1000) ≈ 0.20%
    expect(r.estImpactPct).toBeCloseTo(0.2, 1);
    expect(r.verdict).toBe("negligible");
  });

  it("size overwhelming a thin pool is severe", async () => {
    ucMock.dexTokenPairs.mockResolvedValue(pool(20_000)); // reserve 10k
    const r = await priceImpact({ address: TOKEN, size: "5000" });
    // 5000/(10000+5000) ≈ 33%
    expect(r.estImpactPct).toBeGreaterThan(10);
    expect(r.verdict).toBe("severe");
  });

  it("reports the largest size under 1% impact", async () => {
    ucMock.dexTokenPairs.mockResolvedValue(pool(200_000)); // reserve 100k
    const r = await priceImpact({ address: TOKEN, size: "1000" });
    // maxUnder1 = 100000 * 0.01/0.99 ≈ 1010
    expect(r.maxSizeUnder1pctUsd).toBeGreaterThan(1000);
    expect(r.maxSizeUnder1pctUsd).toBeLessThan(1030);
  });

  it("picks the deepest pool when several exist", async () => {
    ucMock.dexTokenPairs.mockResolvedValue([...pool(5_000), ...pool(500_000)]);
    const r = await priceImpact({ address: TOKEN, size: "1000" });
    expect(r.pool.liquidityUsd).toBe(500_000);
    expect(r.otherPools).toBe(1);
  });

  it("requires a positive USD size", async () => {
    ucMock.dexTokenPairs.mockResolvedValue(pool(100_000));
    await expect(priceImpact({ address: TOKEN, size: "0" })).rejects.toThrow(/size/i);
  });

  it("does not charge when DexScreener is unavailable", async () => {
    ucMock.dexTokenPairs.mockResolvedValue(null);
    await expect(priceImpact({ address: TOKEN, size: "1000" })).rejects.toThrow(/not charged/);
  });

  it("errors cleanly when the token has no liquid pool", async () => {
    ucMock.dexTokenPairs.mockResolvedValue([]);
    await expect(priceImpact({ address: TOKEN, size: "1000" })).rejects.toThrow(/no liquid pool/i);
  });
});
