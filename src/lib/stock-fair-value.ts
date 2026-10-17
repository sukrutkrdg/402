/**
 * stock-fair-value — is the Base price of a tokenized stock fair right now?
 *
 * Coinbase's tokenized stocks trade 24/7 on Base DEXs; the underlying trades
 * 24/5 and the reference price (Chainlink, read by Aave and Morpho) holds its last
 * value whenever the US market is shut. Measured on Saturday 2026-10-17: the ten
 * Chainlink equity feeds were 16–22 h old, while the DEX prices kept moving
 * (−0.26% to +0.61% from the frozen reference, $0.9–2.8M of liquidity per stock).
 *
 * An agent pricing a trade, a loan or a vault therefore needs three answers in
 * one place, and nobody gives them for Coinbase's stocks:
 *   1. which session is the US market in (regular / pre / post / overnight /
 *      closed) — so it knows whether the reference can move at all;
 *   2. how old the reference is, and whether that age is normal for the session;
 *   3. the DEX premium or discount against that reference, and the depth behind it.
 *
 * Reference = the Chainlink feed where Base publishes one, else Coinbase's API
 * `nav_price` (also Chainlink-sourced). Both already include the multiplier
 * ("Token Price = Underlying × Multiplier"), so no further scaling is applied.
 */

import "server-only";
import { createPublicClient, getAddress, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { dexTokenPairs } from "./upstream-cache";
import { deepestPool, type DexPoolLike } from "./dex-pool";
import { findStockBySymbol, stockApiRecord } from "./tokenized-stocks";
import { readStockActions } from "./stock-corporate-actions";
import { kvGet, kvSet } from "./kv";

/**
 * Chainlink feeds for Coinbase tokenized equities on Base. Base's docs list ten;
 * Chainlink's own directory had thirteen on 2026-10-17 (plus INTC, COIN, CRCL), so
 * the directory is read live (cached 6 h) and this table is only the fallback.
 */
export const STOCK_FEEDS: Readonly<Record<string, Address>> = {
  AAPL: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
  AMZN: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
  GOOGL: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
  META: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
  MSFT: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
  MSTR: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
  NVDA: "0x04689a41629776563E6822F76f2e57D148d28513",
  SNDK: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA",
  SPCX: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68",
  TSLA: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
  INTC: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB",
  COIN: "0x408e44f504A7371a345F03a73dDC96A4b48e8aa7",
  CRCL: "0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33",
};

const RDD_URL = "https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json";
const FEEDS_CACHE = "stocks:feeds:v1";

interface RddFeed {
  name?: string;
  proxyAddress?: string;
  docs?: { assetClass?: string; productTypeCode?: string };
}

/** "Coinbase NVDA" equity feeds from Chainlink's directory → ticker → proxy. Pure. */
export function feedsFromDirectory(rows: readonly RddFeed[]): Record<string, Address> {
  const out: Record<string, Address> = {};
  for (const f of rows) {
    const m = f.name?.match(/^Coinbase ([A-Z][A-Z0-9.]*)$/);
    if (!m || f.docs?.assetClass !== "Equity" || !/^0x[0-9a-fA-F]{40}$/.test(f.proxyAddress ?? "")) continue;
    out[m[1]] = f.proxyAddress as Address;
  }
  return out;
}

let feedMemo: { at: number; feeds: Record<string, Address> } | null = null;
export async function stockFeeds(): Promise<Record<string, Address>> {
  if (feedMemo && Date.now() - feedMemo.at < 30 * 60_000) return feedMemo.feeds;
  let live: Record<string, Address> | null = null;
  const cached = await kvGet(FEEDS_CACHE).catch(() => null);
  if (cached) {
    try {
      live = JSON.parse(cached) as Record<string, Address>;
    } catch {
      /* refetch */
    }
  }
  if (!live) {
    const res = await fetch(RDD_URL, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    const rows = res && res.ok ? ((await res.json().catch(() => null)) as RddFeed[] | null) : null;
    if (Array.isArray(rows)) {
      live = feedsFromDirectory(rows);
      if (Object.keys(live).length) await kvSet(FEEDS_CACHE, JSON.stringify(live), 6 * 3600).catch(() => {});
    }
  }
  const feeds = { ...STOCK_FEEDS, ...(live ?? {}) };
  feedMemo = { at: Date.now(), feeds };
  return feeds;
}

/** NYSE full-day closures. Early closes (13:00 ET) are not modelled. */
const NYSE_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

export type Session = "regular" | "pre" | "post" | "overnight" | "closed";

/** New York wall clock for an instant. */
function nyParts(d: Date): { date: string; weekday: number; minutes: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/**
 * The US equity session at `d`, as the 24/5 reference feeds see it: they publish
 * from Sunday 20:00 ET to Friday 20:00 ET. Pure; exported for tests.
 */
export function marketSession(d: Date): Session {
  const { date, weekday, minutes } = nyParts(d);
  const holiday = NYSE_HOLIDAYS.has(date);
  if (weekday === 6) return "closed";
  if (weekday === 0) return minutes >= 20 * 60 ? "overnight" : "closed";
  if (weekday === 5 && minutes >= 20 * 60) return "closed";
  if (holiday) return "closed";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "post";
  return "overnight";
}

/** Hours until the reference can move again (0 when it already can). Pure. */
export function hoursUntilReopen(d: Date): number {
  if (marketSession(d) !== "closed") return 0;
  for (let h = 1; h <= 24 * 5; h++) {
    if (marketSession(new Date(d.getTime() + h * 3600_000)) !== "closed") return h;
  }
  return 24 * 5;
}

export type FairVerdict = "fair" | "premium" | "discount" | "wide" | "no_reference" | "not_trading";

/** Classify the premium in basis points. Pure. */
export function verdictFor(premiumBps: number | null, hasPool: boolean): FairVerdict {
  if (!hasPool) return "not_trading";
  if (premiumBps === null) return "no_reference";
  const a = Math.abs(premiumBps);
  if (a >= 200) return "wide";
  if (a >= 50) return premiumBps > 0 ? "premium" : "discount";
  return "fair";
}

const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)"]);

async function readFeed(addr: Address): Promise<{ price: number; updatedAt: number } | null> {
  try {
    const c = createPublicClient({ chain: base, transport: baseTransport(6000) });
    const [round, dec] = await Promise.all([
      c.readContract({ address: addr, abi: feedAbi, functionName: "latestRoundData" }),
      c.readContract({ address: addr, abi: feedAbi, functionName: "decimals" }).catch(() => 8),
    ]);
    const price = Number(round[1]) / 10 ** Number(dec);
    return price > 0 ? { price, updatedAt: Number(round[3]) } : null;
  } catch {
    return null;
  }
}

interface Pair extends DexPoolLike {
  volume?: { h24?: number };
  priceChange?: { h24?: number };
}

export async function stockFairValue(params: Record<string, string>) {
  const q = (params.symbol || params.ticker || params.token || "").trim();
  if (!q) throw new Error("Provide symbol= (e.g. NVDA, NVDAc or the token address)");
  const stock = await findStockBySymbol(q);
  if (!stock) throw new Error(`${q} is not a Coinbase tokenized stock on Base — not charged`);
  const amountUsd = params.amountUsd ? Number(params.amountUsd) : null;
  if (amountUsd !== null && !(amountUsd > 0)) throw new Error("amountUsd must be a positive number");

  const now = new Date();
  const session = marketSession(now);
  const feedAddr = (await stockFeeds())[stock.ticker.toUpperCase()] ?? null;

  const [pairs, feed, rec, actions] = await Promise.all([
    dexTokenPairs<Pair>(stock.token),
    feedAddr ? readFeed(feedAddr) : Promise.resolve(null),
    stockApiRecord(stock.token).catch(() => null),
    readStockActions([stock]).catch(() => null),
  ]);
  if (pairs === null) throw new Error("DEX data unavailable (DexScreener) — not charged, retry shortly");

  // Reference: Chainlink feed first, else Coinbase's nav_price (Chainlink-sourced).
  let reference: { source: "chainlink" | "coinbase_nav"; price: number; updatedAt: string; ageHours: number; feed?: string } | null = null;
  if (feed) {
    reference = { source: "chainlink", price: feed.price, updatedAt: new Date(feed.updatedAt * 1000).toISOString(), ageHours: 0, feed: feedAddr! };
  } else if (rec && typeof rec.nav_price === "number" && rec.nav_price > 0 && rec.nav_price_updated_at) {
    reference = { source: "coinbase_nav", price: rec.nav_price, updatedAt: rec.nav_price_updated_at, ageHours: 0 };
  }
  if (reference) reference.ageHours = Math.round(((now.getTime() - Date.parse(reference.updatedAt)) / 3600_000) * 10) / 10;

  const deep = deepestPool(pairs, stock.token);
  const dexPrice = deep?.priceUsd ?? null;
  const premiumBps = reference && dexPrice ? Math.round((dexPrice / reference.price - 1) * 10_000) : null;
  const verdict = verdictFor(premiumBps, dexPrice !== null);
  const volume24hUsd = Math.round(pairs.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0));

  // Reference age: while the feed publishes (Sun 20:00 – Fri 20:00 ET) it moves on a
  // 0.5% deviation or a 24 h heartbeat, so > 26 h in an open session is abnormal.
  // While closed, the age is expected and the premium is weekend drift, not error.
  const frozen = session === "closed";
  const stale = reference !== null && !frozen && reference.ageHours > 26;
  const reopenInHours = hoursUntilReopen(now);

  // Rough constant-product impact on the deepest pool; concentrated pools do better.
  const estImpactPct =
    amountUsd !== null && deep && deep.liquidityUsd > 0 ? Math.round((amountUsd / (deep.liquidityUsd / 2 + amountUsd)) * 10_000) / 100 : null;

  const paused = rec?.paused_features?.length ? rec.paused_features : [];
  const pendingAction = (actions ?? []).find((a) => a.status === "announced") ?? null;

  const warnings: string[] = [];
  if (frozen && reference) warnings.push(`US market closed: the reference has not moved for ${reference.ageHours} h and cannot until it reopens in ~${reopenInHours} h. The premium is weekend drift against Friday's price; lenders (Aave, Morpho) still value collateral at the frozen reference.`);
  if (stale) warnings.push(`Reference is ${reference!.ageHours} h old during an open session — abnormal (24 h heartbeat). Do not settle or liquidate against it.`);
  if (paused.length) warnings.push(`Issuer has paused: ${paused.join(", ")}.`);
  if (pendingAction) warnings.push(`${pendingAction.description} announced ${pendingAction.announcedAt ?? ""} — not yet applied. When it is, the multiplier moves and lenders pause this stock's reserve.`);
  if (estImpactPct !== null && estImpactPct >= 1) warnings.push(`A $${amountUsd} trade is large for this pool (~${estImpactPct}% rough impact). Check price-impact for the exact route.`);

  const recommendation =
    verdict === "not_trading"
      ? `${stock.sym} has no live Base pool — it cannot be priced or traded on chain right now.`
      : verdict === "no_reference"
        ? `${stock.sym} trades at $${dexPrice} on Base but has no published reference price, so a premium cannot be measured.`
        : verdict === "fair"
          ? `${stock.sym} trades within ${Math.abs(premiumBps!)} bps of its reference${frozen ? " (Friday's close)" : ""} — fair.`
          : verdict === "wide"
            ? `${stock.sym} is ${premiumBps! > 0 ? "+" : ""}${premiumBps} bps from its reference — a wide gap. ${frozen ? "Expect it to close when the market reopens; buying a premium now risks the Monday gap." : "Check for news, halts or a thin pool before trading."}`
            : `${stock.sym} trades at a ${premiumBps! > 0 ? "premium" : "discount"} of ${Math.abs(premiumBps!)} bps to its reference${frozen ? " (weekend drift — may close at the reopen)" : ""}.`;

  return {
    symbol: stock.sym,
    ticker: stock.ticker,
    name: stock.name,
    token: getAddress(stock.token),
    session,
    referenceFrozen: frozen,
    ...(frozen ? { reopensInHours: reopenInHours } : {}),
    reference,
    referenceStale: stale,
    dex: deep
      ? {
          priceUsd: dexPrice,
          dex: deep.pair.dexId ?? null,
          pool: deep.pair.pairAddress ?? null,
          deepestPoolLiquidityUsd: Math.round(deep.liquidityUsd),
          totalLiquidityUsd: Math.round(deep.totalLiquidityUsd),
          poolCount: deep.poolCount,
          volume24hUsd,
        }
      : null,
    premiumBps,
    verdict,
    ...(amountUsd !== null ? { amountUsd, estImpactPct } : {}),
    multiplier: typeof rec?.multiplier === "number" ? rec.multiplier : null,
    pausedFeatures: paused,
    pendingCorporateAction: pendingAction ? { description: pendingAction.description, announcedAt: pendingAction.announcedAt, uri: pendingAction.uri } : null,
    warnings,
    recommendation,
    note: "Fair value of a Coinbase tokenized stock on Base: US market session, reference price (Chainlink feed, else Coinbase's NAV) and its age, DEX premium/discount and depth. The reference already includes the multiplier. Sessions follow NYSE hours and holidays; early closes are not modelled. Not financial advice.",
    checkedAt: now.toISOString(),
  };
}
