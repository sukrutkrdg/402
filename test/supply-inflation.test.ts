import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * supply-inflation: net zero-address mints/burns over a window vs live totalSupply,
 * annualised. CDP SQL and the on-chain reads are mocked so the rate math and
 * verdict thresholds are what's under test.
 */
const { sqlMock, viemMock } = vi.hoisted(() => ({
  sqlMock: { cdpSql: vi.fn() },
  viemMock: { readContract: vi.fn() },
}));
vi.mock("@/lib/covalent", () => sqlMock);
vi.mock("viem", async (orig) => {
  const actual = await orig<typeof import("viem")>();
  return { ...actual, createPublicClient: () => ({ readContract: viemMock.readContract }) };
});

import { supplyInflation } from "@/lib/supply-inflation";

const TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const WAD = 10n ** 18n;

// cdpSql is called mint-query then burn-query. Values are float strings in wei.
function feed(mint: { c: number; v: number; last?: string }, burn: { c: number; v: number }) {
  sqlMock.cdpSql
    .mockResolvedValueOnce([{ c: String(mint.c), v: String(mint.v), last: mint.last ?? "2026-10-01 00:00:00" }])
    .mockResolvedValueOnce([{ c: String(burn.c), v: String(burn.v) }]);
}
function supply(tokens: bigint) {
  viemMock.readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === "decimals" ? 18 : tokens * WAD,
  );
}

beforeEach(() => {
  sqlMock.cdpSql.mockReset();
  viemMock.readContract.mockReset();
});

describe("supply-inflation", () => {
  it("fixed_in_window when there are no mints or burns", async () => {
    feed({ c: 0, v: 0 }, { c: 0, v: 0 });
    supply(1_000_000n);
    const r = await supplyInflation({ address: TOKEN, days: "30" });
    expect(r.verdict).toBe("fixed_in_window");
    expect(r.mintEvents).toBe(0);
  });

  it("hyperinflation when a large share of supply is minted in the window", async () => {
    // mint 600k tokens (in wei) over 30d on a 1M supply → 60% in 30d → huge annualised
    feed({ c: 10, v: Number(600_000n * WAD) }, { c: 0, v: 0 });
    supply(1_000_000n);
    const r = await supplyInflation({ address: TOKEN, days: "30" });
    expect(r.mintedPctOfSupply).toBeGreaterThan(50);
    expect(r.verdict).toBe("hyperinflation");
  });

  it("deflationary when more is burned than minted", async () => {
    feed({ c: 1, v: Number(1_000n * WAD) }, { c: 5, v: Number(50_000n * WAD) });
    supply(1_000_000n);
    const r = await supplyInflation({ address: TOKEN, days: "30" });
    expect(r.netInflationPct).toBeLessThan(0);
    expect(r.verdict).toBe("deflationary");
  });

  it("low_inflation for a mild rewards-style emission", async () => {
    // 2k minted on 1M supply over 30d → 0.2% in 30d → ~2.4%/yr
    feed({ c: 30, v: Number(2_000n * WAD) }, { c: 0, v: 0 });
    supply(1_000_000n);
    const r = await supplyInflation({ address: TOKEN, days: "30" });
    expect(r.verdict).toBe("low_inflation");
  });

  it("unknown when totalSupply can't be read on-chain", async () => {
    feed({ c: 3, v: Number(100n * WAD) }, { c: 0, v: 0 });
    viemMock.readContract.mockRejectedValue(new Error("rpc down"));
    const r = await supplyInflation({ address: TOKEN, days: "30" });
    expect(r.verdict).toBe("unknown");
    expect(r.mintedPctOfSupply).toBeNull();
  });

  it("does not charge when the warehouse is unavailable", async () => {
    sqlMock.cdpSql.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(supplyInflation({ address: TOKEN, days: "30" })).rejects.toThrow(/not charged/);
  });
});
