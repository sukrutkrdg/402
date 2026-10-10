import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * funding-radar: scans the perp market, groups by coin, OI-weights funding, and
 * ranks the most crowded longs/shorts over a liquidity floor. fetch is mocked.
 */
import { fundingRadar } from "@/lib/funding-radar";

function mockDerivs(rows: unknown) {
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => rows })) as unknown as typeof fetch;
}
const perp = (index: string, funding: number, oi: number, basis = 0) => ({ index_id: index, funding_rate: funding, open_interest: oi, basis, contract_type: "perpetual" });

beforeEach(() => vi.restoreAllMocks());

describe("funding-radar", () => {
  it("ranks crowded longs and shorts over the OI floor", async () => {
    mockDerivs([
      perp("AAA", 0.06, 100_000_000), // very positive → crowded long
      perp("BBB", -0.06, 100_000_000), // very negative → crowded short
      perp("CCC", 0.001, 100_000_000), // neutral
    ]);
    const r = await fundingRadar({ minOi: "10000000" });
    expect(r.coinsOverFloor).toBe(3);
    expect(r.crowdedLongs![0].coin).toBe("AAA");
    expect(r.crowdedShorts![0].coin).toBe("BBB");
  });

  it("filters out coins below the OI floor", async () => {
    mockDerivs([perp("BIG", 0.02, 50_000_000), perp("SMALL", 0.09, 100_000)]);
    const r = await fundingRadar({ minOi: "25000000" });
    expect(r.coinsOverFloor).toBe(1);
    expect(r.crowdedLongs!.map((c) => c.coin)).not.toContain("SMALL");
  });

  it("reports market tilt long when funding is broadly positive", async () => {
    mockDerivs([perp("AAA", 0.03, 100_000_000), perp("BBB", 0.04, 200_000_000)]);
    const r = await fundingRadar({ minOi: "10000000" });
    expect(r.marketTilt).toBe("net_long_crowded");
  });

  it("no_data when nothing clears the floor", async () => {
    mockDerivs([perp("SMALL", 0.05, 100_000)]);
    const r = await fundingRadar({ minOi: "25000000" });
    expect(r.verdict).toBe("no_data");
  });

  it("does not charge when CoinGecko is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("network"); }) as unknown as typeof fetch;
    await expect(fundingRadar({})).rejects.toThrow(/not charged/);
  });
});
