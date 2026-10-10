import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * market-pulse: Fear & Greed + trending + OI-weighted funding, combined into a
 * stance. fetch is mocked and routed by URL so the composite logic is under test.
 */
import { marketPulse } from "@/lib/market-pulse";

function route(fgValue: number, fundingPerPerp: number) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("alternative.me")) return { ok: true, status: 200, json: async () => ({ data: [{ value: String(fgValue), value_classification: fgValue >= 60 ? "Greed" : fgValue <= 40 ? "Fear" : "Neutral" }, { value: String(fgValue - 2) }] }) } as unknown as Response;
    if (u.includes("search/trending")) return { ok: true, status: 200, json: async () => ({ coins: [{ item: { symbol: "pepe", data: { price_change_percentage_24h: { usd: 12 } } } }] }) } as unknown as Response;
    if (u.includes("derivatives")) return { ok: true, status: 200, json: async () => [{ contract_type: "perpetual", funding_rate: fundingPerPerp, open_interest: 1_000_000_000 }] } as unknown as Response;
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => vi.restoreAllMocks());

describe("market-pulse", () => {
  it("frothy when greed meets crowded longs", async () => {
    route(80, 0.03); // greed + strongly positive funding (long crowded)
    const r = await marketPulse({});
    expect(r.stance).toBe("frothy");
    expect(r.leverage!.tilt).toBe("long_crowded");
  });

  it("capitulation_setup when fear meets crowded shorts", async () => {
    route(15, -0.03);
    const r = await marketPulse({});
    expect(r.stance).toBe("capitulation_setup");
  });

  it("risk_on for greed without extreme leverage", async () => {
    route(70, 0.0001);
    const r = await marketPulse({});
    expect(r.stance).toBe("risk_on");
  });

  it("neutral in the middle", async () => {
    route(50, 0.0001);
    const r = await marketPulse({});
    expect(r.stance).toBe("neutral");
  });

  it("surfaces which sources answered", async () => {
    route(50, 0.0001);
    const r = await marketPulse({});
    expect(r.sourcesUsed).toEqual(expect.arrayContaining(["fear-greed", "trending", "funding"]));
  });

  it("does not charge when every source is down", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("network"); }) as unknown as typeof fetch;
    await expect(marketPulse({})).rejects.toThrow(/not charged/);
  });
});
