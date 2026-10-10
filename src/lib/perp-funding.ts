/**
 * perp-funding — the futures side of a trade, for an agent choosing between spot
 * and a perp. Coinbase-for-Agents' own flow asks "compare spot vs an ETH futures
 * contract"; this is the data that comparison needs and nothing in the onchain
 * toolkit has: aggregate perpetual funding, open interest and basis for a coin.
 *
 *   funding  — who pays whom. Positive = longs pay shorts (crowded long, squeeze
 *              risk on a dip); negative = shorts pay (crowded short, squeeze on a
 *              pump). The carry you earn or bleed holding the perp.
 *   basis    — perp vs index: contango (premium) or backwardation (discount).
 *   open interest — how much capital is in the contract (depth / unwind risk).
 *
 * Aggregated OI-weighted across venues from CoinGecko's public derivatives feed
 * (no key). Funding is annualised as an ESTIMATE (assumes 8h intervals; venues
 * differ), said as such. A market-structure signal, not a price call. Not
 * financial advice.
 */

import "server-only";

const CG = "https://api.coingecko.com/api/v3";

interface Deriv {
  market?: string;
  symbol?: string;
  index_id?: string;
  price?: string;
  basis?: number;
  funding_rate?: number;
  open_interest?: number;
  volume_24h?: number;
  contract_type?: string;
}

export async function perpFunding(params: Record<string, string>) {
  const symRaw = (params.symbol || params.coin || params.ticker || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(symRaw)) throw new Error("Provide a coin symbol (symbol=BTC, ETH, SOL…)");

  let res: Response;
  try {
    res = await fetch(`${CG}/derivatives?include_tickers=unexpired`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new Error("Derivatives data unreachable (CoinGecko) — not charged, retry shortly");
  }
  if (res.status === 429) throw new Error("Derivatives data rate-limited upstream — not charged, retry shortly");
  if (!res.ok) throw new Error(`CoinGecko responded ${res.status} — not charged`);
  const all = (await res.json()) as Deriv[];
  if (!Array.isArray(all)) throw new Error("Derivatives data returned an unexpected shape — not charged");

  // Perpetuals for this coin. Match the index first; fall back to the symbol
  // prefix so a coin CoinGecko doesn't index by ticker is still caught.
  const perps = all.filter(
    (d) =>
      (d.contract_type ?? "").toLowerCase() === "perpetual" &&
      ((d.index_id ?? "").toUpperCase() === symRaw || (d.symbol ?? "").toUpperCase().startsWith(symRaw)),
  );

  if (perps.length === 0) {
    return { symbol: symRaw, verdict: "no_perps", venues: 0, note: `No perpetual contracts found for ${symRaw} on CoinGecko's tracked venues — it may not have a liquid perp, or uses a different ticker. Not financial advice.`, checkedAt: new Date().toISOString() };
  }

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // OI-weighted funding + basis (big venues should dominate the signal).
  let oiSum = 0, fundW = 0, basisW = 0, basisOi = 0, fundOi = 0;
  const prices: number[] = [];
  for (const d of perps) {
    const oi = num(d.open_interest) ?? 0;
    oiSum += oi;
    const f = num(d.funding_rate);
    if (f !== null) { fundW += f * (oi || 1); fundOi += oi || 1; }
    const b = num(d.basis);
    if (b !== null) { basisW += b * (oi || 1); basisOi += oi || 1; }
    const p = Number(d.price);
    if (Number.isFinite(p) && p > 0) prices.push(p);
  }
  const fundingPct = fundOi > 0 ? fundW / fundOi : null; // per funding interval, %
  const basisPct = basisOi > 0 ? basisW / basisOi : null;
  prices.sort((a, b) => a - b);
  const refPrice = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  // Annualise: 8h funding → 3×/day. An ESTIMATE — intervals differ by venue.
  const annualFundingPct = fundingPct !== null ? +(fundingPct * 3 * 365).toFixed(1) : null;

  const topVenues = [...perps]
    .sort((a, b) => (num(b.open_interest) ?? 0) - (num(a.open_interest) ?? 0))
    .slice(0, 5)
    .map((d) => ({ venue: d.market ?? null, symbol: d.symbol ?? null, fundingPct: num(d.funding_rate), basisPct: num(d.basis), openInterestUsd: num(d.open_interest) }));

  const side = fundingPct === null ? "unknown" : fundingPct > 0 ? "longs_pay" : fundingPct < 0 ? "shorts_pay" : "flat";
  const absAnn = annualFundingPct !== null ? Math.abs(annualFundingPct) : 0;
  const regime = annualFundingPct === null ? "unknown" : absAnn < 5 ? "neutral" : absAnn < 25 ? "elevated" : "extreme";
  const basisState = basisPct === null ? "unknown" : basisPct > 0.05 ? "contango" : basisPct < -0.05 ? "backwardation" : "flat";

  const usd = (n: number | null) => (n == null ? "?" : "$" + Math.round(n).toLocaleString("en-US"));
  return {
    symbol: symRaw,
    venues: perps.length,
    referencePrice: refPrice,
    openInterestUsd: Math.round(oiSum),
    fundingPctPerInterval: fundingPct !== null ? +fundingPct.toFixed(4) : null,
    annualizedFundingPct: annualFundingPct, // estimate, assumes 8h intervals
    fundingSide: side, // longs_pay | shorts_pay | flat
    fundingRegime: regime, // neutral | elevated | extreme
    basisPct: basisPct !== null ? +basisPct.toFixed(3) : null,
    basisState, // contango | backwardation | flat
    topVenues,
    verdict: regime, // neutral | elevated | extreme | unknown
    recommendation:
      regime === "extreme"
        ? `⚠️ ${symRaw} perp funding is EXTREME (~${annualFundingPct}%/yr, ${side === "longs_pay" ? "longs paying — crowded long" : "shorts paying — crowded short"}) across ${perps.length} venues, ${usd(oiSum)} OI. ${side === "longs_pay" ? "A crowded long bleeds carry and is squeeze-prone on any dip — favour spot over a leveraged perp here." : "A crowded short can squeeze violently on a pump — risky to add to the short side."}`
        : regime === "elevated"
          ? `${symRaw} funding is elevated (~${annualFundingPct}%/yr, ${side === "longs_pay" ? "longs pay" : "shorts pay"}), ${basisState} basis, ${usd(oiSum)} OI. Holding the perp ${fundingPct && fundingPct > 0 ? "costs" : "earns"} meaningful carry vs spot — price that into the spot-vs-futures choice.`
          : regime === "neutral"
            ? `${symRaw} funding is near-neutral (~${annualFundingPct}%/yr), ${basisState} basis, ${usd(oiSum)} OI across ${perps.length} venues. No crowding signal — spot and perp carry are close; decide on leverage/expiry, not funding.`
            : `${symRaw}: funding couldn't be read across ${perps.length} venue(s); ${usd(oiSum)} OI. Treat the futures carry as unknown.`,
    note: "Aggregate OI-weighted perpetual funding, open interest and basis across CoinGecko's tracked venues (no key). Funding annualised assuming 8h intervals — an estimate; venues differ (1h/4h/8h). A market-structure signal for the spot-vs-perp choice, not a price call. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
