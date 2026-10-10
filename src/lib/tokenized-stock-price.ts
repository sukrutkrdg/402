/**
 * tokenized-stock-price — the live ONCHAIN price and liquidity of Coinbase's
 * tokenized equities (AAPLc, TSLAc, NVDAc …). b20_safety tells you a tokenized
 * stock is a real issuance; this tells you what it actually trades at on Base and
 * whether there's liquidity to trade size. Nobody else covers all 82 — the roster
 * is anchored on-chain by the policy admin, not a hand-kept list.
 *
 * Two modes:
 *   - no symbol → a cheap directory of every tokenized equity we track (ticker,
 *     on-chain symbol, name) so an agent knows what it can ask for.
 *   - symbol=AAPL (or AAPLc) → the deepest Base pool's price, aggregate liquidity,
 *     24h move and volume, from DexScreener (no key).
 *
 * The on-chain tokenized price can diverge from the underlying's real NAV (premium
 * / discount, after-hours, thin liquidity) — this is the tradeable Base price, not
 * the NYSE print. Not financial advice.
 */

import "server-only";
import { getAddress } from "viem";
import { TOKENIZED_STOCKS } from "./tokenized-stocks";
import { dexTokenPairs } from "./upstream-cache";

interface Pair {
  baseToken?: { address?: string };
  quoteToken?: { symbol?: string };
  dexId?: string;
  pairAddress?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
}

export async function tokenizedStockPrice(params: Record<string, string>) {
  const raw = (params.symbol || params.ticker || params.sym || "").trim().toUpperCase();

  // Directory mode — no upstream call, just the roster.
  if (!raw) {
    return {
      mode: "directory",
      count: TOKENIZED_STOCKS.length,
      stocks: TOKENIZED_STOCKS.map((s) => ({ ticker: s.ticker, sym: s.sym, name: s.name })),
      note: "Every Coinbase tokenized equity we track (anchored on-chain by the policy admin, not a hand-kept list). Pass symbol=AAPL (or AAPLc) for its live on-chain price and liquidity. Not financial advice.",
      checkedAt: new Date().toISOString(),
    };
  }

  // Match by ticker, on-chain sym, or ticker+c.
  const want = raw.endsWith("C") ? raw.slice(0, -1) : raw;
  const stock = TOKENIZED_STOCKS.find((s) => s.ticker.toUpperCase() === want || s.sym.toUpperCase() === raw || s.ticker.toUpperCase() === raw);
  if (!stock) {
    return {
      mode: "lookup",
      symbol: raw,
      verdict: "unknown_ticker",
      note: `${raw} is not a tokenized equity we track. Call with no symbol for the full list. (This is Coinbase's tokenized stocks on Base, e.g. AAPL, TSLA, NVDA.) Not financial advice.`,
      checkedAt: new Date().toISOString(),
    };
  }

  const token = stock.token.toLowerCase();
  const raw2 = await dexTokenPairs<Pair>(token);
  if (raw2 === null) throw new Error("Price source unavailable (DexScreener) — not charged, retry shortly");

  const pools = (raw2 || [])
    .filter((p) => p?.baseToken?.address?.toLowerCase() === token && Number(p.priceUsd) > 0)
    .map((p) => ({
      dex: p.dexId ?? null,
      pair: p.pairAddress ?? null,
      quote: p.quoteToken?.symbol ?? null,
      priceUsd: Number(p.priceUsd),
      liquidityUsd: p.liquidity?.usd ?? 0,
      volume24h: p.volume?.h24 ?? 0,
      change24hPct: typeof p.priceChange?.h24 === "number" ? p.priceChange.h24 : null,
    }))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);

  const base = { ticker: stock.ticker, sym: stock.sym, name: stock.name, token: getAddress(stock.token) };

  if (pools.length === 0) {
    return { mode: "lookup", ...base, verdict: "not_trading", note: `${stock.sym} has no live Base pool right now — it's issued but not currently trading on a DEX we can read (or liquidity was pulled). Can't price it. Not financial advice.`, checkedAt: new Date().toISOString() };
  }

  const deepest = pools[0];
  const aggLiquidityUsd = Math.round(pools.reduce((s, p) => s + p.liquidityUsd, 0));
  const aggVolume24h = Math.round(pools.reduce((s, p) => s + p.volume24h, 0));
  const verdict = aggLiquidityUsd >= 50_000 ? "liquid" : aggLiquidityUsd >= 5_000 ? "thin" : "illiquid";

  return {
    mode: "lookup",
    ...base,
    priceUsd: deepest.priceUsd,
    change24hPct: deepest.change24hPct,
    aggregateLiquidityUsd: aggLiquidityUsd,
    volume24hUsd: aggVolume24h,
    poolCount: pools.length,
    deepestPool: { dex: deepest.dex, quote: deepest.quote, liquidityUsd: Math.round(deepest.liquidityUsd) },
    verdict, // liquid | thin | illiquid | not_trading | unknown_ticker
    recommendation:
      verdict === "liquid"
        ? `${stock.sym} trades at ~$${deepest.priceUsd} on ${deepest.dex} (${deepest.change24hPct != null ? (deepest.change24hPct >= 0 ? "+" : "") + deepest.change24hPct + "% 24h" : "24h n/a"}), $${aggLiquidityUsd.toLocaleString("en-US")} liquidity across ${pools.length} pool(s) — tradeable size. Pair with price-impact before a large order, and b20-safety to confirm the issuance.`
        : verdict === "thin"
          ? `${stock.sym} ~$${deepest.priceUsd}, but only $${aggLiquidityUsd.toLocaleString("en-US")} liquidity — thin. Expect slippage on any size; check price-impact first.`
          : `${stock.sym} ~$${deepest.priceUsd} but near-zero liquidity ($${aggLiquidityUsd.toLocaleString("en-US")}) — effectively untradeable without heavy slippage.`,
    note: "Live on-chain price + liquidity of a Coinbase tokenized equity on Base (DexScreener, no key). This is the tradeable Base price, which can diverge from the underlying's NYSE NAV (premium/discount, after-hours, thin pools). Pair with b20-safety (real issuance?) and price-impact (your size). Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
