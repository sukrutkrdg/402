/**
 * Market sentiment & discovery — two of the most-checked commodity reads a
 * trading agent makes: the crypto Fear & Greed Index and what's trending.
 *
 * Complements crypto-markets/crypto-global (the prices) with the mood (F&G) and
 * the discovery feed (trending). Both wrap public no-key upstreams (alternative.me,
 * CoinGecko). A failed upstream is surfaced, never returned empty.
 */

import "server-only";

// ---------------------------------------------------------------------------
// fear-greed — crypto Fear & Greed Index (alternative.me)
// ---------------------------------------------------------------------------

export async function fearGreed(params: Record<string, string>) {
  const days = Math.min(Math.max(Number(params.days) || 1, 1), 30);
  let res: Response;
  try {
    res = await fetch(`https://api.alternative.me/fng/?limit=${days}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error("Fear & Greed source unreachable — not charged, retry shortly");
  }
  if (!res.ok) throw new Error(`Fear & Greed source responded ${res.status} — not charged`);
  const j = (await res.json()) as { data?: Array<{ value?: string; value_classification?: string; timestamp?: string }> };
  const data = j.data ?? [];
  if (data.length === 0) throw new Error("Fear & Greed returned no data — not charged");

  const now = data[0];
  const value = Number(now.value);
  const history = data.map((d) => ({
    value: Number(d.value),
    label: d.value_classification ?? null,
    date: d.timestamp ? new Date(Number(d.timestamp) * 1000).toISOString().slice(0, 10) : null,
  }));
  const prev = history[1]?.value ?? null;

  return {
    value, // 0 (extreme fear) … 100 (extreme greed)
    classification: now.value_classification ?? null,
    changeVsPrevDay: prev != null ? value - prev : null,
    history,
    recommendation:
      value <= 25 ? "Extreme fear — historically where capitulation and bottoms form; contrarians accumulate, but it is fear for a reason."
        : value >= 75 ? "Extreme greed — froth and local-top risk; size down and tighten stops."
          : value >= 55 ? "Greed — risk-on, but not extreme."
            : value <= 45 ? "Fear — cautious market."
              : "Neutral.",
    note: "Crypto Fear & Greed Index (alternative.me): 0 = extreme fear, 100 = extreme greed, from volatility, momentum, volume, social and dominance. A sentiment gauge, not a signal. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// crypto-trending — globally trending coins (CoinGecko)
// ---------------------------------------------------------------------------

interface TrendItem { item?: { id?: string; name?: string; symbol?: string; market_cap_rank?: number; data?: { price?: number; price_change_percentage_24h?: { usd?: number }; market_cap?: string } } }

export async function cryptoTrending(_params: Record<string, string>) {
  let res: Response;
  try {
    res = await fetch("https://api.coingecko.com/api/v3/search/trending", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error("Trending source unreachable (CoinGecko) — not charged, retry shortly");
  }
  if (res.status === 429) throw new Error("Trending rate-limited upstream — not charged, retry shortly");
  if (!res.ok) throw new Error(`CoinGecko responded ${res.status} — not charged`);
  const j = (await res.json()) as { coins?: TrendItem[] };
  const coins = (j.coins ?? []).map((c, i) => ({
    trendingRank: i + 1,
    symbol: (c.item?.symbol ?? "").toUpperCase(),
    name: c.item?.name ?? null,
    marketCapRank: c.item?.market_cap_rank ?? null,
    priceUsd: c.item?.data?.price ?? null,
    change24hPct: c.item?.data?.price_change_percentage_24h?.usd != null ? +c.item.data.price_change_percentage_24h.usd.toFixed(2) : null,
  }));
  if (coins.length === 0) throw new Error("Trending returned no coins — not charged");

  return {
    count: coins.length,
    coins,
    note: "The coins most searched on CoinGecko right now — a global attention/discovery feed, not a quality or safety signal. For trending on Base DEXes specifically use trending-tokens; vet anything here with token-risk before touching it. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
