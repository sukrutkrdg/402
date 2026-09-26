import { describe, it, expect, afterEach, vi } from "vitest";
import { nearSwapBook } from "@/lib/near-swap-ledger";
import { _resetNearCaches } from "@/lib/near-rpc";
import { stubNear } from "./stubs/near-stub";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetNearCaches();
});

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

describe("nearSwapBook", () => {
  it("reads what the fee account earned inside NEAR Intents and states the split", async () => {
    vi.stubEnv("NEAR_INTENTS_FEE_RECIPIENT", "fees.near");
    vi.stubEnv("NEAR_INTENTS_FEE_BPS", "20");
    stubNear({
      tokens: [{ assetId: USDC, decimals: 6, blockchain: "near", symbol: "USDC", price: 1, contractAddress: USDC.slice(7) }],
      views: {
        "intents.near.mt_tokens_for_owner": [{ token_id: USDC }],
        "intents.near.mt_balance_of": (a: Record<string, unknown>) => (a.account_id === "fees.near" && a.token_id === USDC ? "5000" : "0"),
      },
    });
    const b = await nearSwapBook();
    expect(b).toMatchObject({ feeOn: true, feeBps: 20, userPaysPct: 0.2, weKeepPct: 0.1, recipient: "fees.near" });
    expect(b.earned).toMatchObject({ totalUsd: 0.005, balances: [{ symbol: "USDC", amount: "0.005", usd: 0.005 }] });
  });

  it("with the fee off there is nothing earned to read", async () => {
    stubNear({});
    expect(await nearSwapBook()).toMatchObject({ feeOn: false, earned: null, weKeepPct: 0 });
  });
});
