/**
 * polymarket-odds — Event prediction probabilities and consensus odds from Polymarket.
 *
 * Autonomous AI agents use prediction markets for real-world reality checks:
 * before hedging, trading, or allocating treasury, is an event likely?
 * Queries Polymarket's Gamma API for active markets, resolves outcome odds (Yes/No),
 * 24h volume, liquidity, and resolution status.
 */

import "server-only";

interface MarketOutcome {
  outcome: string;
  price: number;
  percentage: string;
}

interface GammaMarket {
  id?: string;
  question?: string;
  slug?: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string | number;
  liquidity?: string | number;
  active?: boolean;
  closed?: boolean;
  endDate?: string;
}

interface GammaEvent {
  id?: string;
  title?: string;
  slug?: string;
  volume?: number;
  liquidity?: number;
  markets?: GammaMarket[];
}

const CACHE = new Map<string, { at: number; data: unknown }>();
const TTL_MS = 60_000; // 60s cache

export function _resetPolymarketCache() {
  CACHE.clear();
}

export async function polymarketOdds(params: Record<string, string>) {
  const query = (params.query || params.slug || params.market || params.search || "crypto").trim();
  if (!query) throw new Error("query= required (e.g. 'fed', 'btc', 'kraken-ipo-in-2025')");

  const cacheKey = query.toLowerCase();
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return cached.data as Record<string, unknown>;
  }

  let events: GammaEvent[] = [];
  try {
    // 1. Try slug direct match first if query looks like a slug
    if (/^[a-z0-9-]+$/.test(query)) {
      const slugRes = await fetch(
        `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(query)}`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }
      );
      if (slugRes.ok) {
        const j = (await slugRes.json()) as GammaEvent[];
        if (Array.isArray(j) && j.length > 0) events = j;
      }
    }

    // 2. If no event by slug, search by title keyword
    if (events.length === 0) {
      const searchRes = await fetch(
        `https://gamma-api.polymarket.com/events?title=${encodeURIComponent(query)}&closed=false&limit=5`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }
      );
      if (searchRes.ok) {
        const j = (await searchRes.json()) as GammaEvent[];
        if (Array.isArray(j)) events = j;
      }
    }

    // 3. Fallback: general query on markets if still empty
    if (events.length === 0) {
      const allRes = await fetch(
        `https://gamma-api.polymarket.com/events?closed=false&limit=10`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }
      );
      if (allRes.ok) {
        const all = (await allRes.json()) as GammaEvent[];
        if (Array.isArray(all)) {
          const lower = query.toLowerCase();
          events = all.filter((e) => e.title?.toLowerCase().includes(lower) || e.slug?.toLowerCase().includes(lower));
          if (events.length === 0 && all.length > 0) events = [all[0]]; // best-effort top market
        }
      }
    }
  } catch (e) {
    throw new Error(`Polymarket upstream unreachable (${(e as Error).name}) — not charged, retry shortly`);
  }

  const topEvent = events[0];
  if (!topEvent) {
    const emptyResult = {
      query,
      found: false,
      verdict: "not_found",
      note: `No active prediction market found matching '${query}' on Polymarket. Try a broader keyword like 'fed', 'btc', or 'election'.`,
      checkedAt: new Date().toISOString(),
    };
    return emptyResult;
  }

  const topMarket = topEvent.markets?.[0];
  let outcomes: MarketOutcome[] = [];

  if (topMarket?.outcomes && topMarket?.outcomePrices) {
    try {
      const names = JSON.parse(topMarket.outcomes) as string[];
      const prices = JSON.parse(topMarket.outcomePrices) as (string | number)[];
      outcomes = names.map((name, i) => {
        const p = parseFloat(String(prices[i] ?? "0")) || 0;
        return {
          outcome: name,
          price: Math.round(p * 1000) / 1000,
          percentage: `${(p * 100).toFixed(1)}%`,
        };
      });
    } catch {
      outcomes = [];
    }
  }

  const yesOutcome = outcomes.find((o) => o.outcome.toLowerCase() === "yes");
  const topOutcome = outcomes.slice().sort((a, b) => b.price - a.price)[0];

  const primaryProb = yesOutcome ? yesOutcome.price : topOutcome ? topOutcome.price : 0.5;
  const verdict =
    primaryProb >= 0.75
      ? "high_probability"
      : primaryProb >= 0.55
        ? "moderate_probability"
        : primaryProb >= 0.45
          ? "toss_up"
          : primaryProb >= 0.25
            ? "low_probability"
            : "unlikely";

  const volumeNum = typeof topEvent.volume === "number" ? topEvent.volume : parseFloat(String(topMarket?.volume || "0"));
  const volumeUsd = `$${Math.round(volumeNum || 0).toLocaleString("en-US")}`;

  const result = {
    query,
    found: true,
    title: topEvent.title || topMarket?.question || "Prediction Market",
    slug: topEvent.slug || topMarket?.slug,
    verdict,
    consensusProbability: yesOutcome ? yesOutcome.percentage : topOutcome ? `${topOutcome.outcome} (${topOutcome.percentage})` : "n/a",
    outcomes,
    volumeUsd,
    endDate: topMarket?.endDate || null,
    source: "Polymarket Gamma CLOB",
    url: topEvent.slug ? `https://polymarket.com/event/${topEvent.slug}` : "https://polymarket.com",
    checkedAt: new Date().toISOString(),
  };

  CACHE.set(cacheKey, { at: Date.now(), data: result });
  return result;
}
