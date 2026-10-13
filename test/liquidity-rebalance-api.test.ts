import { describe, it, expect } from "vitest";
import { GET, POST, AERODROME_CL_POOLS } from "../src/app/api/liquidity/rebalance/route";

describe("Aerodrome Concentrated Liquidity API (/api/liquidity/rebalance)", () => {
  it("GET returns active Aerodrome CL pools with TVL and fee APRs", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.network).toContain("Base Mainnet");
    expect(json.builderCode).toBe("bc_pa0gqlv1");
    expect(json.totalTvlUsdc).toBeGreaterThan(0);
    expect(Array.isArray(json.pools)).toBe(true);
    expect(json.pools.length).toBeGreaterThanOrEqual(4);
  });

  it("POST computes optimal tick range and EIP-3009 execution plan", async () => {
    const req = new Request("http://localhost:3000/api/liquidity/rebalance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        poolId: "pool-degen-weth",
        capitalUsdc: 1000,
        rangeTolerancePct: 5,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.pair).toBe("DEGEN-WETH");
    expect(json.builderCode).toBe("bc_pa0gqlv1");

    // Recommendations
    expect(json.rebalanceRecommendation.targetRangePct).toBe("±5%");
    expect(json.rebalanceRecommendation.lowerPrice).toBeLessThan(json.currentPrice);
    expect(json.rebalanceRecommendation.upperPrice).toBeGreaterThan(json.currentPrice);
    expect(json.rebalanceRecommendation.projectedConcentratedApy).toBeGreaterThan(0);

    // Execution Plan
    expect(json.executionPlan.settlementProtocol).toBe("x402 (EIP-3009)");
    expect(json.executionPlan.gasSponsorship).toContain("0 Gwei");
    expect(json.executionPlan.status).toBe("READY_TO_SIGN");
  });

  it("handles out of range pool with URGENT_REBALANCE recommendation", async () => {
    const req = new Request("http://localhost:3000/api/liquidity/rebalance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        poolId: "pool-virtual-weth",
        capitalUsdc: 2500,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.rebalanceRecommendation.action).toBe("URGENT_REBALANCE");
  });
});
