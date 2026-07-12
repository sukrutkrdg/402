import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * watchlist-diff outage discipline. Regression for the audit HIGH: a DexScreener
 * blip must NOT be read as liquidity=0 (which fabricated LIQUIDITY_DOWN_100% and
 * then persisted the zeroed baseline, poisoning every later paid diff).
 */
const { dexMock, gpMock, kvMock } = vi.hoisted(() => ({
  dexMock: vi.fn(),
  gpMock: vi.fn(),
  kvMock: { kvGet: vi.fn(), kvSet: vi.fn(), kvConfigured: vi.fn() },
}));
vi.mock("@/lib/upstream-cache", () => ({ dexTokenPairs: dexMock, goPlusSecurity: gpMock }));
vi.mock("@/lib/kv", () => kvMock);

import { watchlistDiff } from "@/lib/watchlist";

const TOKEN = "0x1111111111111111111111111111111111111111";

function pairsWithLiquidity(usd: number, price = 1) {
  return [{ baseToken: { address: TOKEN }, liquidity: { usd }, priceUsd: String(price), pairAddress: "0xpair" }];
}

interface DiffResult {
  changes: Array<{
    token: string;
    liquidityUsd: number | null;
    liquidityChangePct: number | null;
    alerts: string[];
    unavailable?: string[];
  }>;
  degraded?: boolean;
}

describe("watchlist-diff — outages are unknown, never zero", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvMock.kvConfigured.mockReturnValue(true);
    kvMock.kvSet.mockResolvedValue(undefined);
    gpMock.mockResolvedValue({ is_honeypot: "0", sell_tax: "0" });
  });

  it("re-check with DexScreener down does NOT fire a liquidity alert", async () => {
    // Baseline had healthy liquidity; now the provider returns null (outage).
    kvMock.kvGet.mockResolvedValue(
      JSON.stringify({
        id: "wl_x",
        tokens: [TOKEN],
        snaps: { [TOKEN]: { liq: 500000, price: 1, honeypot: false, sellTax: 0 } },
        createdAt: "x",
        updatedAt: "x",
      }),
    );
    dexMock.mockResolvedValue(null); // outage — NOT []

    const r = (await watchlistDiff({ watchId: "wl_x" })) as DiffResult;
    const c = r.changes[0];
    expect(c.alerts).not.toContain("LIQUIDITY_DOWN_100%");
    expect(c.alerts).toHaveLength(0);
    expect(c.liquidityUsd).toBeNull();
    expect(c.liquidityChangePct).toBeNull();
    expect(c.unavailable).toContain("dex");
    expect(r.degraded).toBe(true);
  });

  it("preserves the previous known baseline when a provider is down (no zero persistence)", async () => {
    kvMock.kvGet.mockResolvedValue(
      JSON.stringify({
        id: "wl_x",
        tokens: [TOKEN],
        snaps: { [TOKEN]: { liq: 500000, price: 1, honeypot: false, sellTax: 0 } },
        createdAt: "x",
        updatedAt: "x",
      }),
    );
    dexMock.mockResolvedValue(null);

    await watchlistDiff({ watchId: "wl_x" });
    const saved = JSON.parse(kvMock.kvSet.mock.calls[0][1]);
    // The stored baseline keeps the last GOOD liquidity, not 0.
    expect(saved.snaps[TOKEN].liq).toBe(500000);
  });

  it("still fires a genuine liquidity drop when data is present on both sides", async () => {
    kvMock.kvGet.mockResolvedValue(
      JSON.stringify({
        id: "wl_x",
        tokens: [TOKEN],
        snaps: { [TOKEN]: { liq: 500000, price: 1, honeypot: false, sellTax: 0 } },
        createdAt: "x",
        updatedAt: "x",
      }),
    );
    dexMock.mockResolvedValue(pairsWithLiquidity(50000)); // real -90%

    const r = (await watchlistDiff({ watchId: "wl_x" })) as DiffResult;
    expect(r.changes[0].alerts.some((a) => a.startsWith("LIQUIDITY_DOWN_"))).toBe(true);
  });

  it("refuses to create a baseline when both providers are down (buyer not charged)", async () => {
    dexMock.mockResolvedValue(null);
    gpMock.mockResolvedValue(null);
    await expect(watchlistDiff({ tokens: TOKEN })).rejects.toThrow(/unavailable/i);
  });

  it("creates a watchId when at least one provider answers", async () => {
    dexMock.mockResolvedValue(pairsWithLiquidity(100000));
    const r = (await watchlistDiff({ tokens: TOKEN })) as { watchId: string; created: boolean };
    expect(r.created).toBe(true);
    expect(r.watchId).toMatch(/^wl_[0-9a-f]{18}$/); // crypto-random, not Math.random
  });
});
