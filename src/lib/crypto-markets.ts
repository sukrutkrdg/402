/**
 * Global crypto market data — the "~50 top assets" snapshot the x402 ecosystem
 * buys heavily (and CoinGecko/CMC resell per call at $0.01).
 *
 * Our other price tools are Base-token-address based; this is the cross-asset,
 * global view an agent uses to read the market: top coins by market cap, and a
 * one-call market overview (total cap, BTC/ETH dominance, 24h move). Wraps the
 * CoinGecko public API (no key). A failed upstream is surfaced, never empty.
 */

import "server-only";

const CG = "https://api.coingecko.com/api/v3";

interface CoinRow {
  id?: string; symbol?: string; name?: string; current_price?: number; market_cap?: number;
  market_cap_rank?: number; total_volume?: number; price_change_percentage_24h?: number;
}

export async function cryptoMarkets(params: Record<string, string>) {
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 100);
  const vs = (params.vs || params.currency || "usd").toLowerCase().trim();
  if (!/^[a-z]{2,5}$/.test(vs)) throw new Error("vs must be a currency code (usd, eur, …)");

  let res: Response;
  try {
    res = await fetch(`${CG}/coins/markets?vs_currency=${vs}&order=market_cap_desc&per_page=${limit}&page=1&price_change_percentage=24h`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new Error("Market data unreachable (CoinGecko) — not charged, retry shortly");
  }
  if (res.status === 429) throw new Error("Market data rate-limited upstream — not charged, retry shortly");
  if (!res.ok) throw new Error(`CoinGecko responded ${res.status} — not charged`);
  const rows = (await res.json()) as CoinRow[];
  if (!Array.isArray(rows)) throw new Error("Market data returned an unexpected shape — not charged");

  const coins = rows.map((c) => ({
    rank: c.market_cap_rank ?? null,
    symbol: (c.symbol ?? "").toUpperCase(),
    name: c.name ?? null,
    price: c.current_price ?? null,
    marketCap: c.market_cap ?? null,
    volume24h: c.total_volume ?? null,
    change24hPct: c.price_change_percentage_24h != null ? +c.price_change_percentage_24h.toFixed(2) : null,
  }));

  return {
    vs,
    count: coins.length,
    coins,
    note: "Top assets by market cap (CoinGecko). Live cross-asset market data for agents; for a specific Base token's DEX price use token-price. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

export async function cryptoGlobal(_params: Record<string, string>) {
  let res: Response;
  try {
    res = await fetch(`${CG}/global`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new Error("Market overview unreachable (CoinGecko) — not charged, retry shortly");
  }
  if (res.status === 429) throw new Error("Market overview rate-limited upstream — not charged, retry shortly");
  if (!res.ok) throw new Error(`CoinGecko responded ${res.status} — not charged`);
  const j = (await res.json()) as {
    data?: {
      total_market_cap?: Record<string, number>; total_volume?: Record<string, number>;
      market_cap_percentage?: Record<string, number>; market_cap_change_percentage_24h_usd?: number;
      active_cryptocurrencies?: number; markets?: number;
    };
  };
  const d = j.data;
  if (!d?.total_market_cap?.usd) throw new Error("Market overview returned an unexpected shape — not charged");

  const dom = d.market_cap_percentage ?? {};
  return {
    totalMarketCapUsd: Math.round(d.total_market_cap.usd),
    totalMarketCapT: +(d.total_market_cap.usd / 1e12).toFixed(3),
    volume24hUsd: d.total_volume?.usd != null ? Math.round(d.total_volume.usd) : null,
    marketCapChange24hPct: d.market_cap_change_percentage_24h_usd != null ? +d.market_cap_change_percentage_24h_usd.toFixed(2) : null,
    dominancePct: { btc: dom.btc != null ? +dom.btc.toFixed(2) : null, eth: dom.eth != null ? +dom.eth.toFixed(2) : null },
    activeCoins: d.active_cryptocurrencies ?? null,
    note: "One-call crypto market overview (CoinGecko): total market cap, 24h volume and move, BTC/ETH dominance. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
