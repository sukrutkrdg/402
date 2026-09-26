import { describe, it, expect, afterEach, vi } from "vitest";
import { nearStakingYields } from "@/lib/near-staking-yields";
import { _resetNearCaches } from "@/lib/near-rpc";
import { stubNear } from "./stubs/near-stub";

afterEach(() => {
  vi.unstubAllGlobals();
  _resetNearCaches();
});

const DAY = 86_400_000;
const NOW = 1_790_000_000_000; // ms
const HEAD = 200_000_000;
const MS_PER_BLOCK = 1000;
const timeOf = (h: number) => NOW - (HEAD - h) * MS_PER_BLOCK;

/** Current state through stubNear; archival `block` and `query` at a block_id answered here. */
function world(then: Record<string, string>, now: Record<string, string>, skipped: number[] = []) {
  stubNear({
    tokens: [
      { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 2, contractAddress: "wrap.near" },
      { assetId: "nep141:linear-protocol.near", decimals: 24, blockchain: "near", symbol: "LiNEAR", price: 2.4, contractAddress: "linear-protocol.near" },
    ],
    views: {
      "linear-protocol.near.ft_price": now.linear,
      "linear-protocol.near.get_summary": { total_staked_near_amount: (10_000_000n * 10n ** 24n).toString() },
      "meta-pool.near.get_st_near_price": now.meta,
      "meta-pool.near.get_contract_state": { total_actually_staked: (5_000_000n * 10n ** 24n).toString() },
    },
    quote: (b) => ({ quote: { amountIn: String(b.amount), amountOut: "1", amountOutFormatted: "495", amountInFormatted: "x" } }),
  });
  const current = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "402", result }));
      if (body.method === "block") {
        const h = body.params.finality ? HEAD : Number(body.params.block_id);
        if (skipped.includes(h)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: "402", error: { cause: { name: "UNKNOWN_BLOCK" } } }));
        return ok({ header: { height: h, timestamp: timeOf(h) * 1_000_000, timestamp_nanosec: String(timeOf(h) * 1_000_000) } });
      }
      if (body.method === "query" && body.params.block_id !== undefined) {
        const v = body.params.account_id === "linear-protocol.near" ? then.linear : then.meta;
        return ok({ result: Array.from(Buffer.from(JSON.stringify(v))), logs: [] });
      }
      return current(url, init);
    }),
  );
}

describe("nearStakingYields", () => {
  it("annualises the redemption-price change over the window and ranks providers", async () => {
    const one = 10n ** 24n;
    // LiNEAR: 1.2 → 1.2 * 1.001 in 7 days; Meta: 1.3 → 1.3 * 1.0005
    const lin0 = (one * 12n) / 10n, met0 = (one * 13n) / 10n;
    world(
      { linear: lin0.toString(), meta: met0.toString() },
      { linear: ((lin0 * 1001n) / 1000n).toString(), meta: ((met0 * 10005n) / 10000n).toString() },
      [HEAD - 100_000],
    );
    const r = await nearStakingYields({});
    expect(r.window.days).toBeCloseTo(7, 1);
    expect(r.best?.provider).toBe("LiNEAR");
    const lin = r.providers[0];
    // (1.001)^(365/7) − 1 ≈ 5.35%
    expect(lin.apyPct).toBeCloseTo(5.35, 1);
    expect(lin).toMatchObject({ stakedNear: 10_000_000, stakedUsd: 20_000_000 });
    expect(r.providers[1].apyPct).toBeCloseTo(2.64, 1);
    // LiNEAR is routed: an instant-exit figure; Meta Pool is not in the stub list
    expect(lin.instantExit).toHaveProperty("discountPct");
    expect(r.providers[1].instantExit).toMatchObject({ unavailable: expect.stringMatching(/not routed/) });
  });

  it("rejects a bad window", async () => {
    await expect(nearStakingYields({ days: "90" })).rejects.toThrow(/days/);
  });
});
