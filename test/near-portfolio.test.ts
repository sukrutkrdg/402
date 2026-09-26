import { describe, it, expect, afterEach, vi } from "vitest";
import { nearPortfolio } from "@/lib/near-portfolio";
import { _resetNearCaches, type IntentsToken } from "@/lib/near-rpc";
import { stubNear } from "./stubs/near-stub";

afterEach(() => {
  vi.unstubAllGlobals();
  _resetNearCaches();
});

const TOKENS: IntentsToken[] = [
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 5, contractAddress: "wrap.near" },
  { assetId: "nep141:usdt.tether-token.near", decimals: 6, blockchain: "near", symbol: "USDt", price: 1, contractAddress: "usdt.tether-token.near" },
  { assetId: "nep141:dead.near", decimals: 18, blockchain: "near", symbol: "DEAD", price: 0, contractAddress: "dead.near" },
  { assetId: "nep141:base-0xabc.omft.near", decimals: 6, blockchain: "base", symbol: "USDC", price: 1, contractAddress: "0xabc" },
];

describe("nearPortfolio", () => {
  it("values NEAR (liquid + staked) and held tokens, sorted, with coverage", async () => {
    const calls = stubNear({
      accounts: { "alice.near": { amount: (10n * 10n ** 24n).toString(), locked: (2n * 10n ** 24n).toString() } },
      tokens: TOKENS,
      views: {
        "wrap.near.ft_balance_of": "0",
        "usdt.tether-token.near.ft_balance_of": (a: Record<string, unknown>) => (a.account_id === "alice.near" ? "250500000" : "0"),
      },
    });
    const r = await nearPortfolio({ account: "alice.near" });
    expect(r).toMatchObject({
      exists: true,
      near: { liquidNear: "10", stakedNear: "2", priceUsd: 5, valueUsd: 60 },
      holdings: [{ symbol: "USDt", balance: "250.5", valueUsd: 250.5 }],
      totalUsd: 310.5,
      coverage: { tokensScanned: 2 },
    });
    // unpriced and non-NEAR entries are not scanned
    const scanned = calls.filter((c) => (c.body?.params as { method_name?: string } | undefined)?.method_name === "ft_balance_of");
    expect(scanned).toHaveLength(2);
  });

  it("an account that does not exist is worth nothing, not an error", async () => {
    stubNear({ accounts: {}, tokens: TOKENS });
    expect(await nearPortfolio({ account: "ghost.near" })).toMatchObject({ exists: false, totalUsd: 0, holdings: [] });
  });

  it("rejects what is not a NEAR account", async () => {
    const calls = stubNear({});
    await expect(nearPortfolio({ account: "not valid" })).rejects.toThrow(/NEAR account/);
    expect(calls).toEqual([]);
  });
});
