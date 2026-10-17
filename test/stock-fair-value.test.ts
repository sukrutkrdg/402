import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  pairs: vi.fn(),
  record: vi.fn(),
  actions: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@/lib/upstream-cache", () => ({ dexTokenPairs: m.pairs }));
vi.mock("@/lib/kv", () => ({ kvGet: vi.fn(async () => "{}"), kvSet: vi.fn(async () => {}) }));
vi.mock("@/lib/stock-corporate-actions", () => ({ readStockActions: m.actions }));
vi.mock("@/lib/tokenized-stocks", async (orig) => ({ ...(await orig<object>()), stockApiRecord: m.record }));
vi.mock("viem", async (orig) => {
  const v = await orig<typeof import("viem")>();
  return { ...v, createPublicClient: () => ({ readContract: m.read }) };
});

import { marketSession, hoursUntilReopen, verdictFor, stockFairValue, feedsFromDirectory } from "@/lib/stock-fair-value";

const NVDA = "0xb20000000000000000000078ee7ce2fe4908108c";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

describe("market session (America/New_York)", () => {
  it.each([
    ["2026-10-17T15:00:00Z", "closed"], // Saturday
    ["2026-10-18T23:00:00Z", "closed"], // Sunday 19:00 ET
    ["2026-10-19T00:30:00Z", "overnight"], // Sunday 20:30 ET
    ["2026-10-19T12:00:00Z", "pre"], // Monday 08:00 ET
    ["2026-10-19T14:00:00Z", "regular"], // Monday 10:00 ET
    ["2026-10-19T21:00:00Z", "post"], // Monday 17:00 ET
    ["2026-10-20T03:00:00Z", "overnight"], // Monday 23:00 ET
    ["2026-10-24T00:30:00Z", "closed"], // Friday 20:30 ET
    ["2026-11-26T15:00:00Z", "closed"], // Thanksgiving
  ])("%s → %s", (iso, want) => {
    expect(marketSession(new Date(iso))).toBe(want);
  });

  it("counts hours to the Sunday-evening reopen", () => {
    // Saturday 11:00 ET → Sunday 20:00 ET is 33 h.
    expect(hoursUntilReopen(new Date("2026-10-17T15:00:00Z"))).toBe(33);
    expect(hoursUntilReopen(new Date("2026-10-19T14:00:00Z"))).toBe(0);
  });
});

describe("feed directory", () => {
  it("keeps only Coinbase equity feeds", () => {
    expect(
      feedsFromDirectory([
        { name: "Coinbase INTC", proxyAddress: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB", docs: { assetClass: "Equity" } },
        { name: "ETH / USD", proxyAddress: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", docs: { assetClass: "Crypto" } },
        { name: "rwaUSD NAV", proxyAddress: "0xD8B5397eDE8B83553BdFCCAA496dd771c5336D37", docs: { assetClass: "Tokenized Asset" } },
      ]),
    ).toEqual({ INTC: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB" });
  });
});

describe("verdict", () => {
  it("bands the premium", () => {
    expect(verdictFor(10, true)).toBe("fair");
    expect(verdictFor(61, true)).toBe("premium");
    expect(verdictFor(-75, true)).toBe("discount");
    expect(verdictFor(-250, true)).toBe("wide");
    expect(verdictFor(null, true)).toBe("no_reference");
    expect(verdictFor(null, false)).toBe("not_trading");
  });
});

describe("stockFairValue", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T15:00:00Z")); // Saturday
    m.pairs.mockResolvedValue([
      { pairAddress: "0xpool", dexId: "aerodrome", baseToken: { address: NVDA }, quoteToken: { address: USDC }, priceUsd: "214.63", liquidity: { usd: 2_000_000 }, volume: { h24: 7_000_000 } },
    ]);
    m.record.mockResolvedValue({ multiplier: 1.000538, paused_features: [] });
    m.actions.mockResolvedValue([]);
    // latestRoundData then decimals
    m.read.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === "decimals" ? 8 : [1n, 21399000000n, 0n, BigInt(Math.floor(Date.parse("2026-10-16T20:00:00Z") / 1000)), 1n],
    );
  });

  it("measures the weekend premium against the frozen Chainlink reference", async () => {
    const r = (await stockFairValue({ symbol: "NVDA", amountUsd: "1000" })) as Record<string, any>;
    expect(r.session).toBe("closed");
    expect(r.referenceFrozen).toBe(true);
    expect(r.reference.source).toBe("chainlink");
    expect(r.reference.ageHours).toBe(19);
    expect(r.premiumBps).toBe(30);
    expect(r.verdict).toBe("fair");
    expect(r.referenceStale).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/market closed/);
    expect(r.estImpactPct).toBeGreaterThan(0);
  });

  it("falls back to Coinbase's NAV for a stock with no published feed", async () => {
    m.record.mockResolvedValue({ nav_price: 80, nav_price_updated_at: "2026-10-16T21:00:00Z", paused_features: [] });
    m.pairs.mockResolvedValue([
      { pairAddress: "0xp2", dexId: "uniswap", baseToken: { address: "0xb2000000000000000000007d16372840df4dabbe" }, quoteToken: { address: USDC }, priceUsd: "82.4", liquidity: { usd: 50_000 } },
    ]);
    const r = (await stockFairValue({ symbol: "PLTR" })) as Record<string, any>;
    expect(r.reference.source).toBe("coinbase_nav");
    expect(r.premiumBps).toBe(300);
    expect(r.verdict).toBe("wide");
  });

  it("surfaces an announced dividend", async () => {
    m.actions.mockResolvedValue([{ status: "announced", description: "Cash Dividend", announcedAt: "2026-10-02T00:00:00Z", uri: "u" }]);
    const r = (await stockFairValue({ symbol: "NVDAc" })) as Record<string, any>;
    expect(r.pendingCorporateAction.description).toBe("Cash Dividend");
    expect(r.warnings.join(" ")).toMatch(/lenders pause/);
  });

  it("refuses an unknown stock and a DEX outage without charging", async () => {
    await expect(stockFairValue({ symbol: "NOPE" })).rejects.toThrow(/not charged/);
    m.pairs.mockResolvedValue(null);
    await expect(stockFairValue({ symbol: "NVDA" })).rejects.toThrow(/not charged/);
  });
});
