import { describe, it, expect, vi, beforeEach } from "vitest";
import { polymarketOdds, _resetPolymarketCache } from "@/lib/polymarket";

beforeEach(() => {
  _resetPolymarketCache();
  vi.restoreAllMocks();
});

describe("polymarket-odds", () => {
  it("resolves market event odds and consensus probabilities", async () => {
    const mockEvents = [
      {
        id: "1001",
        title: "Fed Interest Rate Cut in next FOMC?",
        slug: "fed-rate-cut-next-fomc",
        volume: 5400000,
        markets: [
          {
            question: "Fed cut rates?",
            outcomes: JSON.stringify(["Yes", "No"]),
            outcomePrices: JSON.stringify(["0.725", "0.275"]),
            volume: "5400000",
            endDate: "2026-11-01T00:00:00Z",
          },
        ],
      },
    ];

    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockEvents,
    } as Response);

    const res = (await polymarketOdds({ query: "fed-rate-cut-next-fomc" })) as any;
    expect(res.found).toBe(true);
    expect(res.title).toBe("Fed Interest Rate Cut in next FOMC?");
    expect(res.verdict).toBe("moderate_probability");
    expect(res.consensusProbability).toBe("72.5%");
    expect(res.outcomes).toHaveLength(2);
    expect(res.outcomes[0].outcome).toBe("Yes");
    expect(res.outcomes[0].percentage).toBe("72.5%");
    expect(res.source).toBe("Polymarket Gamma CLOB");
  });

  it("handles markets where no results are found gracefully", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    const res = (await polymarketOdds({ query: "nonexistent-crypto-unknown-event-xyz" })) as any;
    expect(res.found).toBe(false);
    expect(res.verdict).toBe("not_found");
    expect(res.note).toContain("No active prediction market found");
  });

  it("never answers a keyword with an unrelated or ended market", async () => {
    // 2026-10-17: "fed" answered "Kraken IPO by ___?", a market that ended in 2025.
    const kraken = { title: "Kraken IPO by ___ ?", slug: "kraken-ipo-in-2025", endDate: "2025-12-31T12:00:00Z", markets: [] };
    const fedEnded = { title: "Fed decision in September?", slug: "fed-sept", closed: true, markets: [] };
    const fedLive = {
      title: "Fed decision in December?",
      slug: "fed-decision-in-december",
      markets: [{ outcomes: JSON.stringify(["Yes", "No"]), outcomePrices: JSON.stringify(["0.6", "0.4"]), endDate: "2099-12-10T00:00:00Z" }],
    };
    vi.spyOn(global, "fetch").mockImplementation(async (u) => {
      const url = String(u);
      if (url.includes("slug=")) return { ok: true, json: async () => [] } as Response;
      if (url.includes("public-search")) return { ok: true, json: async () => ({ events: [kraken, fedEnded, fedLive] }) } as Response;
      return { ok: true, json: async () => [kraken] } as Response;
    });
    const res = (await polymarketOdds({ query: "fed" })) as any;
    expect(res.title).toBe("Fed decision in December?");
  });

  it("says not found rather than returning an unrelated market", async () => {
    const kraken = { title: "Kraken IPO by ___ ?", slug: "kraken-ipo", markets: [] };
    vi.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => [kraken] } as Response);
    const res = (await polymarketOdds({ query: "fed" })) as any;
    expect(res.found).toBe(false);
  });

  it("throws clean not-charged error when upstream is unreachable", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("Network connection reset"));

    await expect(polymarketOdds({ query: "fed" })).rejects.toThrow(/Polymarket upstream unreachable/);
  });
});
