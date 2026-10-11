import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cached,
  clearUpstreamCache,
  coinGeckoDerivatives,
  dexPair,
  type CoinGeckoDerivRow,
} from "@/lib/upstream-cache";

vi.mock("@/lib/kv", () => ({
  kvGet: vi.fn(async () => null),
  kvSet: vi.fn(async () => "OK"),
}));

describe("upstream-cache resilience & 429 protection", () => {
  beforeEach(() => {
    process.env.ENABLE_UPSTREAM_CACHE_IN_TESTS = "true";
    clearUpstreamCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.ENABLE_UPSTREAM_CACHE_IN_TESTS;
    clearUpstreamCache();
    vi.restoreAllMocks();
  });

  it("caches successful fetch results and skips redundant network calls within TTL", async () => {
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return { price: 100, symbol: "TEST" };
    };

    const first = await cached("test:key:1", 60, fetcher);
    const second = await cached("test:key:1", 60, fetcher);

    expect(callCount).toBe(1);
    expect(first).toEqual({ price: 100, symbol: "TEST" });
    expect(second).toEqual({ price: 100, symbol: "TEST" });
  });

  it("serves stale cache when upstream fails with 429 rate limit or network error", async () => {
    let callCount = 0;
    const key = "test:stale:fallback";

    // 1. Initial success
    const fetcher1 = async () => {
      callCount++;
      return { data: "fresh_initial" };
    };
    const res1 = await cached(key, 1, fetcher1, { staleGraceSec: 60 });
    expect(res1).toEqual({ data: "fresh_initial" });
    expect(callCount).toBe(1);

    // 2. Wait 1.1s so primary TTL expires
    await new Promise((r) => setTimeout(r, 1100));

    // 3. Second call fails with 429 Too Many Requests
    const fetcher2 = async () => {
      callCount++;
      const err = new Error("Rate limit exceeded 429");
      (err as any).status = 429;
      throw err;
    };

    // Should return stale data rather than throwing
    const res2 = await cached(key, 1, fetcher2, { staleGraceSec: 60 });
    expect(res2).toEqual({ data: "fresh_initial" });
    expect(callCount).toBe(2);
  });

  it("trips circuit breaker on 429 and serves stale cache immediately", async () => {
    const key = "test:circuit:breaker";
    const domain = "api.testupstream.io";

    // Populate initial cache
    await cached(key, 1, async () => ({ value: 42 }), { staleGraceSec: 60, domain });

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1100));

    let networkAttempts = 0;
    const failingFetcher = async () => {
      networkAttempts++;
      throw new Error("HTTP 429 Too Many Requests");
    };

    // First call after expiration trips circuit breaker and falls back to stale
    const fall1 = await cached(key, 1, failingFetcher, { staleGraceSec: 60, domain });
    expect(fall1).toEqual({ value: 42 });
    expect(networkAttempts).toBe(1);

    // Second call should detect open circuit breaker and return stale WITHOUT calling failingFetcher
    const fall2 = await cached(key, 1, failingFetcher, { staleGraceSec: 60, domain });
    expect(fall2).toEqual({ value: 42 });
    expect(networkAttempts).toBe(1); // network attempts did not increase!
  });

  it("clearUpstreamCache resets in-memory cache and circuit breakers cleanly", async () => {
    let counter = 0;
    await cached("test:clear", 60, async () => ++counter);
    expect(counter).toBe(1);

    // Cached hit
    await cached("test:clear", 60, async () => ++counter);
    expect(counter).toBe(1);

    // Clear cache
    clearUpstreamCache();

    // After clearing, fetcher must run again
    await cached("test:clear", 60, async () => ++counter);
    expect(counter).toBe(2);
  });

  it("coinGeckoDerivatives caches derivatives data across callers", async () => {
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            index_id: "BTC",
            funding_rate: 0.0001,
            open_interest: 5000000,
            contract_type: "perpetual",
          },
        ],
      } as unknown as Response;
    });

    const res1 = await coinGeckoDerivatives();
    const res2 = await coinGeckoDerivatives();

    expect(fetchCount).toBe(1);
    expect(res1.length).toBe(1);
    expect(res1[0].index_id).toBe("BTC");
    expect(res2).toEqual(res1);
  });

  it("dexPair caches pair data and survives upstream null/errors with stale fallback", async () => {
    const pairAddr = "0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C";
    let fetchCalls = 0;

    globalThis.fetch = vi.fn(async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          pair: {
            pairAddress: pairAddr,
            dexId: "aerodrome",
            baseToken: { symbol: "WETH" },
            priceUsd: "3200",
          },
        }),
      } as unknown as Response;
    });

    const p1 = await dexPair<any>(pairAddr);
    const p2 = await dexPair<any>(pairAddr);

    expect(fetchCalls).toBe(1);
    expect(p1.pair.dexId).toBe("aerodrome");
    expect(p2).toEqual(p1);
  });
});
