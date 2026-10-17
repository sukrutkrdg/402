/**
 * The deepest DEX pool a token trades in, on either side of the pair.
 *
 * DexScreener's priceUsd is the price of a pair's BASE token, so the price
 * readers kept only pairs where the queried token is the base. That is right
 * for the price and wrong for depth: USDC, WETH and cbBTC are usually the QUOTE
 * side, so their deep pools were never looked at. On 2026-10-17 token-price,
 * exit-liquidity and token-info all reported USDC at $140k of liquidity (one
 * small Aerodrome pair) while its AERO/USDC pool alone held $43M, and
 * exit-liquidity put a $1,000 USDC sale at 1.4% impact.
 *
 * Here every pool counts. When the deepest one has the token as its quote side,
 * the token's USD price is derived from the base: base USD ÷ priceNative (the
 * base priced in the quote token).
 */

export interface DexPoolLike {
  pairAddress?: string;
  dexId?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number };
}

export interface DeepestPool<P> {
  pair: P;
  /** Which side of `pair` the token is on. */
  side: "base" | "quote";
  /** The token's USD price read from this pool, or null when it cannot be derived. */
  priceUsd: number | null;
  liquidityUsd: number;
  /** Sum over every pool holding the token, either side. */
  totalLiquidityUsd: number;
  poolCount: number;
}

export function deepestPool<P extends DexPoolLike>(pairs: readonly P[], address: string): DeepestPool<P> | null {
  const a = address.toLowerCase();
  const mine = pairs.filter((p) => p?.baseToken?.address?.toLowerCase() === a || p?.quoteToken?.address?.toLowerCase() === a);
  if (mine.length === 0) return null;
  const liq = (p: P) => Number(p.liquidity?.usd) || 0;
  const pair = mine.reduce((t, p) => (liq(p) > liq(t) ? p : t), mine[0]);
  const side = pair.baseToken?.address?.toLowerCase() === a ? "base" : "quote";
  let priceUsd: number | null;
  if (side === "base") {
    const v = parseFloat(pair.priceUsd ?? "");
    priceUsd = Number.isFinite(v) && v > 0 ? v : null;
  } else {
    const baseUsd = parseFloat(pair.priceUsd ?? "");
    const native = parseFloat(pair.priceNative ?? "");
    priceUsd = Number.isFinite(baseUsd) && Number.isFinite(native) && native > 0 ? baseUsd / native : null;
  }
  return {
    pair,
    side,
    priceUsd,
    liquidityUsd: liq(pair),
    totalLiquidityUsd: mine.reduce((t, p) => t + liq(p), 0),
    poolCount: mine.length,
  };
}

/** The token's own symbol/name on a pair, whichever side it is on. */
export function selfToken<P extends DexPoolLike>(pair: P, address: string) {
  return pair.baseToken?.address?.toLowerCase() === address.toLowerCase() ? pair.baseToken : pair.quoteToken;
}
