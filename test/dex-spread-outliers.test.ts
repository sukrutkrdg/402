import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * A thin pool with a stale price must not set the spread. AERO once read a 31%
 * "wide" gap on /radar because a $6.5k pool sat at $0.687 while the $45M pool and
 * every deep venue agreed within 1%. Deep or comparable venues that disagree are
 * a real gap and must still read wide.
 */

vi.mock("@/lib/kv", () => ({
  kvConfigured: () => false,
  kvGet: vi.fn(async () => null),
  kvSet: vi.fn(async () => undefined),
}));

const { dexSpread, weightedMedian } = await import("@/lib/dex-spread");

const pool = (base: string, dex: string, price: number, liq: number, i: number) => ({
  chainId: "base",
  dexId: dex,
  pairAddress: `0x${String(i).padStart(40, "0")}`,
  baseToken: { address: base, symbol: "T" },
  quoteToken: { symbol: "USDC" },
  priceUsd: String(price),
  liquidity: { usd: liq },
  volume: { h24: 1 },
});

let n = 0;
/** A fresh address per test, so dexTokenPairs' in-memory cache never carries over. */
function stub(pools: Array<[string, number, number]>) {
  const addr = `0x${(++n).toString(16).padStart(40, "a")}`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ pairs: pools.map(([d, p, l], i) => pool(addr, d, p, l, i)) }) })),
  );
  return addr;
}

afterEach(() => vi.unstubAllGlobals());

describe("dex-spread thin outliers", () => {
  it("AERO shape: a stale $6.5k pool is listed as an outlier, not the spread", async () => {
    const address = stub([
      ["aerodrome", 0.8932, 45_357_578],
      ["aerodrome", 0.8881, 3_499_843],
      ["aerodrome", 0.8944, 2_460_894],
      ["aerodrome", 0.8928, 2_437_560],
      ["aerodrome", 0.8876, 1_778_486],
      ["aerodrome", 0.901, 18_764],
      ["uniswap", 0.6871, 6_501],
    ]);
    const r = await dexSpread({ address });
    expect(r.thinOutliers.map((o) => o.priceUsd)).toEqual([0.6871]);
    expect(r.thinOutliers[0].deviationPct).toBeLessThan(-20);
    expect(r.spreadPct).toBeLessThan(3); // was 31.1
    expect(r.verdict).not.toBe("wide");
    expect(r.cheapest?.priceUsd).toBe(0.8876);
    expect(r.outlierNote).toMatch(/left out of the spread/);
  });

  it("two deep venues that disagree still read wide", async () => {
    const address = stub([
      ["aerodrome", 1.0, 2_000_000],
      ["uniswap", 1.1, 1_500_000],
    ]);
    const r = await dexSpread({ address });
    expect(r.thinOutliers).toEqual([]);
    expect(r.verdict).toBe("wide");
    expect(r.spreadPct).toBe(10);
  });

  it("two comparable thin pools that disagree are a gap, not one outlier", async () => {
    const address = stub([
      ["aerodrome", 0.5, 20_000],
      ["uniswap", 0.7, 18_000],
    ]);
    const r = await dexSpread({ address });
    expect(r.thinOutliers).toEqual([]);
    expect(r.verdict).toBe("wide");
  });

  it("a thin pool close to the market stays in the comparison", async () => {
    const address = stub([
      ["aerodrome", 1.0, 5_000_000],
      ["uniswap", 1.02, 8_000],
    ]);
    const r = await dexSpread({ address });
    expect(r.thinOutliers).toEqual([]);
    expect(r.comparedVenues).toBe(2);
    expect(r.verdict).toBe("arb_window");
  });

  it("weightedMedian follows liquidity, not pool count", () => {
    expect(weightedMedian([])).toBeNull();
    expect(
      weightedMedian([
        { priceUsd: 0.5, liquidityUsd: 10 },
        { priceUsd: 0.6, liquidityUsd: 10 },
        { priceUsd: 1.0, liquidityUsd: 1_000 },
      ]),
    ).toBe(1.0);
  });
});
