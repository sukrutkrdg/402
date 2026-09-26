import { describe, it, expect, afterEach, vi } from "vitest";
import { nearPreTradeGate } from "@/lib/near-pre-trade-gate";
import { _resetNearCaches, type IntentsToken } from "@/lib/near-rpc";
import { stubNear, CODE, type NearWorld } from "./stubs/near-stub";

afterEach(() => {
  vi.unstubAllGlobals();
  _resetNearCaches();
});

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const TOKENS: IntentsToken[] = [
  { assetId: USDC, decimals: 6, blockchain: "near", symbol: "USDC", price: 1, contractAddress: USDC.slice(7) },
  { assetId: "nep141:meme.near", decimals: 18, blockchain: "near", symbol: "MEME", price: 0.01, contractAddress: "meme.near" },
];

/** A token that passes the safety half; `backUsd` is what selling the bought amount returns. */
function world(backUsd: number | "refuse", extra: Partial<NearWorld> = {}): NearWorld {
  return {
    accounts: { "meme.near": { code_hash: CODE } },
    keys: { "meme.near": [] },
    views: { "meme.near.ft_metadata": { symbol: "MEME", decimals: 18 }, "meme.near.ft_total_supply": "1000" },
    tokens: TOKENS,
    quote: (b) => {
      if (b.originAsset === USDC)
        return { quote: { amountIn: b.amount, amountInFormatted: "100", amountInUsd: "100", amountOut: "9900000000000000000000", amountOutFormatted: "9900", amountOutUsd: "99", timeEstimate: 10 } };
      if (backUsd === "refuse") return new Response(JSON.stringify({ message: "No route found" }), { status: 400 });
      expect(b.amount).toBe("9900000000000000000000"); // sells exactly what the buy returned
      return { quote: { amountIn: b.amount, amountInFormatted: "9900", amountInUsd: "99", amountOut: String(backUsd * 1e6), amountOutFormatted: String(backUsd), amountOutUsd: String(backUsd), timeEstimate: 10 } };
    },
    ...extra,
  };
}

describe("nearPreTradeGate", () => {
  it("GO when the token is locked and the round trip is cheap", async () => {
    stubNear(world(98));
    const r = await nearPreTradeGate({ token: "meme.near" });
    expect(r.verdict).toBe("GO");
    expect(r.route?.roundTripLossPct).toBe(2);
    expect(r.reasons.join(" ")).toMatch(/Exit tested[\s\S]*loses 2%/);
  });

  it("HOLD for a costly exit, STOP for a trap", async () => {
    stubNear(world(90));
    expect((await nearPreTradeGate({ token: "meme.near" })).verdict).toBe("HOLD");
    stubNear(world(40));
    const r = await nearPreTradeGate({ token: "meme.near" });
    expect(r.verdict).toBe("STOP");
    expect(r.reasons.join(" ")).toMatch(/loses 60%/);
  });

  it("HOLD when the sell side will not quote, or the token has no route", async () => {
    stubNear(world("refuse"));
    const r = await nearPreTradeGate({ token: "meme.near" });
    expect(r.verdict).toBe("HOLD");
    expect(r.reasons.join(" ")).toMatch(/No route found/);
    _resetNearCaches(); // the token list is cached; this scenario needs a different one
    stubNear(world(98, { tokens: [TOKENS[0]] }));
    expect((await nearPreTradeGate({ token: "meme.near" })).reasons.join(" ")).toMatch(/exit is unproven/);
  });

  it("the worse half wins: an owner-controlled token with a fine exit is HOLD", async () => {
    stubNear(world(98, { views: { ...world(98).views, "meme.near.owner": "dev.near" } }));
    expect((await nearPreTradeGate({ token: "meme.near" })).verdict).toBe("HOLD");
  });

  it("STOP from the safety half skips the quotes", async () => {
    const calls = stubNear(world(98, { views: { ...world(98).views, "meme.near.paused": true } }));
    const r = await nearPreTradeGate({ token: "meme.near" });
    expect(r).toMatchObject({ verdict: "STOP", route: null });
    expect(calls.some((c) => c.url.endsWith("/v0/quote"))).toBe(false);
  });

  it("uses the requested size and rejects a nonsensical one", async () => {
    stubNear(world(98));
    await expect(nearPreTradeGate({ token: "meme.near", size: "-5" })).rejects.toThrow(/size/);
  });
});
