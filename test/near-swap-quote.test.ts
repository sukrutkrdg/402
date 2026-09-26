import { describe, it, expect, afterEach, vi } from "vitest";
import { nearSwapQuote, resolveAsset } from "@/lib/near-swap-quote";
import { _resetNearCaches, type IntentsToken } from "@/lib/near-rpc";
import { stubNear } from "./stubs/near-stub";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetNearCaches();
});

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const TOKENS: IntentsToken[] = [
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 4.9, contractAddress: "wrap.near" },
  { assetId: USDC_NEAR, decimals: 6, blockchain: "near", symbol: "USDC", price: 1, contractAddress: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" },
  { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, blockchain: "base", symbol: "USDC", price: 1, contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  { assetId: "nep141:btc.omft.near", decimals: 8, blockchain: "btc", symbol: "BTC", price: 84000 },
];

describe("resolveAsset", () => {
  it("resolves ids, NEAR accounts, symbols (NEAR chain by default) and symbol@chain", () => {
    expect((resolveAsset(TOKENS, "nep141:wrap.near") as IntentsToken).symbol).toBe("wNEAR");
    expect((resolveAsset(TOKENS, "wrap.near") as IntentsToken).assetId).toBe("nep141:wrap.near");
    expect((resolveAsset(TOKENS, "NEAR") as IntentsToken).assetId).toBe("nep141:wrap.near");
    expect((resolveAsset(TOKENS, "usdc") as IntentsToken).assetId).toBe(USDC_NEAR);
    expect((resolveAsset(TOKENS, "USDC@base") as IntentsToken).blockchain).toBe("base");
  });

  it("says where a symbol lives when it is not on the chain asked for", () => {
    expect(resolveAsset(TOKENS, "BTC")).toEqual({ error: expect.stringMatching(/on: btc — write e\.g\. BTC@btc/) });
    expect(resolveAsset(TOKENS, "DOGEZILLA")).toEqual({ error: expect.stringMatching(/not an asset NEAR Intents routes/) });
  });
});

describe("nearSwapQuote", () => {
  it("sends an EXACT_INPUT dry quote in base units and reports cost", async () => {
    let sent: Record<string, unknown> = {};
    stubNear({
      tokens: TOKENS,
      quote: (b) => {
        sent = b;
        return { quote: { amountIn: "100000000", amountInFormatted: "100.0", amountInUsd: "100.01", amountOut: "20000000000000000000000000", amountOutFormatted: "20.0", amountOutUsd: "98.0", minAmountOut: "19800000000000000000000000", timeEstimate: 20 } };
      },
    });
    const r = await nearSwapQuote({ from: "USDC", to: "NEAR", amount: "100" });
    expect(sent).toMatchObject({ dry: true, swapType: "EXACT_INPUT", originAsset: USDC_NEAR, destinationAsset: "nep141:wrap.near", amount: "100000000" });
    expect(r).toMatchObject({ amountOut: "20.0", minAmountOut: "19.8", rate: 0.2, costPct: 2.01, timeEstimateSec: 20, from: { symbol: "USDC", chain: "near" }, to: { symbol: "wNEAR" } });
    expect(r.notes.join(" ")).toMatch(/partner key/);
  });

  it("flags a costly quote", async () => {
    stubNear({ tokens: TOKENS, quote: () => ({ quote: { amountIn: "1", amountInFormatted: "1", amountInUsd: "100", amountOut: "1", amountOutFormatted: "1", amountOutUsd: "90", timeEstimate: 5 } }) });
    const r = await nearSwapQuote({ from: "USDC", to: "NEAR", amount: "100" });
    expect(r.costPct).toBe(10);
    expect(r.notes.join(" ")).toMatch(/High cost: 10%/);
  });

  it("passes a 1Click refusal through as the caller's problem, an outage as ours", async () => {
    stubNear({ tokens: TOKENS, quote: () => new Response(JSON.stringify({ message: "Amount is too low" }), { status: 400 }) });
    await expect(nearSwapQuote({ from: "USDC", to: "NEAR", amount: "0.0001" })).rejects.toThrow(/No quote: Amount is too low/);
    stubNear({ tokens: TOKENS, quote: () => new Response("boom", { status: 503 }) });
    await expect(nearSwapQuote({ from: "USDC", to: "NEAR", amount: "1" })).rejects.toThrow(/not charged/);
  });

  it("rejects bad input before quoting", async () => {
    const calls = stubNear({ tokens: TOKENS });
    await expect(nearSwapQuote({ from: "USDC", to: "USDC", amount: "1" })).rejects.toThrow(/same asset/);
    await expect(nearSwapQuote({ from: "USDC", to: "NEAR", amount: "-3" })).rejects.toThrow(/positive number of USDC/);
    await expect(nearSwapQuote({ from: "USDC", to: "", amount: "1" })).rejects.toThrow(/to: required/);
    expect(calls.some((c) => c.url.endsWith("/v0/quote"))).toBe(false);
  });
});
