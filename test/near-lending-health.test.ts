import { describe, it, expect, afterEach, vi } from "vitest";
import { nearLendingHealth } from "@/lib/near-lending-health";
import { _resetNearCaches } from "@/lib/near-rpc";
import { stubNear } from "./stubs/near-stub";

afterEach(() => {
  vi.unstubAllGlobals();
  _resetNearCaches();
});

const TOKENS = [
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 2, contractAddress: "wrap.near" },
  { assetId: "nep141:usdc.near", decimals: 6, blockchain: "near", symbol: "USDC", price: 1, contractAddress: "usdc.near" },
];
const ASSETS = [
  { token_id: "wrap.near", config: { volatility_ratio: 6000, extra_decimals: 0 } },
  { token_id: "usdc.near", config: { volatility_ratio: 9500, extra_decimals: 12 } },
];
const E = (n: number, d: number) => (BigInt(n) * 10n ** BigInt(d)).toString();

function world(positions: unknown) {
  stubNear({
    tokens: TOKENS,
    views: {
      "contract.main.burrow.near.get_assets_paged_detailed": ASSETS,
      "contract.main.burrow.near.get_account_all_positions": positions,
    },
  });
}

describe("nearLendingHealth", () => {
  it("computes health as the contract does and says how far collateral can fall", async () => {
    // 1000 NEAR ($2000) collateral at 60%, 500 USDC borrowed at 95% (18 = 6 + 12 extra decimals)
    world({ supplied: [], positions: { REGULAR: { collateral: [{ token_id: "wrap.near", balance: E(1000, 24) }], borrowed: [{ token_id: "usdc.near", balance: E(500, 18) }] } } });
    const r = await nearLendingHealth({ account: "alice.near" });
    // 2000*0.6 / (500/0.95) = 1200 / 526.3158 = 228%
    expect(r).toMatchObject({ verdict: "GO", healthPct: 228, collateralUsd: 2000, borrowedUsd: 500 });
    expect(r.dropToLiquidationPct).toBeCloseTo(56.14, 1);
  });

  it("near liquidation is STOP", async () => {
    world({ positions: { REGULAR: { collateral: [{ token_id: "wrap.near", balance: E(450, 24) }], borrowed: [{ token_id: "usdc.near", balance: E(500, 18) }] } } });
    const r = await nearLendingHealth({ account: "alice.near" });
    expect(r.verdict).toBe("STOP"); // 540 / 526.3 = 102.6%
    expect(r.healthPct).toBeLessThan(110);
  });

  it("no account means nothing to liquidate", async () => {
    world(null);
    expect(await nearLendingHealth({ account: "bob.near" })).toMatchObject({ hasPosition: false, verdict: "GO" });
  });
});
