import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * perp-funding: OI-weighted funding / basis / OI for a coin's perpetuals, from
 * CoinGecko's derivatives feed. fetch is mocked so the aggregation + verdict
 * (neutral / elevated / extreme, longs_pay / shorts_pay, contango / backwardation)
 * is what's under test.
 */
import { perpFunding } from "@/lib/perp-funding";

function mockDerivs(rows: unknown) {
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => rows })) as unknown as typeof fetch;
}
const perp = (index: string, funding: number, oi: number, basis: number, price = "100", market = "X") => ({
  market, symbol: index + "USDT", index_id: index, price, basis, funding_rate: funding, open_interest: oi, contract_type: "perpetual",
});

beforeEach(() => vi.restoreAllMocks());

describe("perp-funding", () => {
  it("neutral when funding is tiny", async () => {
    mockDerivs([perp("BTC", 0.001, 1_000_000_000, 0.02), perp("BTC", -0.001, 500_000_000, 0.01)]);
    const r = await perpFunding({ symbol: "BTC" });
    expect(r.venues).toBe(2);
    expect(r.verdict).toBe("neutral");
  });

  it("extreme + longs_pay when funding is strongly positive", async () => {
    // 0.05%/8h → annualized 0.05*3*365 ≈ 54.75% → extreme
    mockDerivs([perp("ETH", 0.05, 2_000_000_000, 0.3)]);
    const r = await perpFunding({ symbol: "ETH" });
    expect(r.fundingSide).toBe("longs_pay");
    expect(r.verdict).toBe("extreme");
    expect(r.annualizedFundingPct).toBeGreaterThan(25);
  });

  it("shorts_pay + backwardation when funding and basis are negative", async () => {
    mockDerivs([perp("SOL", -0.05, 800_000_000, -0.4)]);
    const r = await perpFunding({ symbol: "SOL" });
    expect(r.fundingSide).toBe("shorts_pay");
    expect(r.basisState).toBe("backwardation");
  });

  it("OI-weights funding toward the bigger venue", async () => {
    // big venue +0.04, tiny venue -0.04 → weighted strongly positive
    mockDerivs([perp("BTC", 0.04, 10_000_000_000, 0.2), perp("BTC", -0.04, 1_000_000, -0.1)]);
    const r = await perpFunding({ symbol: "BTC" });
    expect(r.fundingPctPerInterval).toBeGreaterThan(0.03);
  });

  it("no_perps when the coin has no perpetuals", async () => {
    mockDerivs([{ ...perp("BTC", 0.01, 1, 0), contract_type: "futures" }]);
    const r = await perpFunding({ symbol: "DOGE" });
    expect(r.verdict).toBe("no_perps");
  });

  it("does not charge when CoinGecko is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("network"); }) as unknown as typeof fetch;
    await expect(perpFunding({ symbol: "BTC" })).rejects.toThrow(/not charged/);
  });

  it("rejects a bad symbol", async () => {
    await expect(perpFunding({ symbol: "" })).rejects.toThrow(/symbol/i);
  });
});
