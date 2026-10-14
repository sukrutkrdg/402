/**
 * Radar: cross-DEX price spreads on Base for a fixed watchlist, computed with the
 * same dexSpread() the paid `dex-spread` service sells.
 *
 * The watchlist is fixed and documented below — liquid Base tokens that trade on
 * several venues, so a spread reading means something. Nothing is ranked or
 * picked at runtime.
 *
 * A token we could not read is reported as `no_data` with the reason, and every
 * number on it is null — never 0, because a 0 bps spread is a claim (prices
 * agree) that we would not have measured. A token with only one liquid venue is
 * read fine but has no cross-venue spread, so its spread is null too.
 *
 * Cost: the whole snapshot is cached 60s (memory + KV, shared across instances),
 * so page views do not fan out — at most one DexScreener call per watchlist
 * token per minute, and those go through dexTokenPairs' own 45s cache shared
 * with paid calls.
 */

import "server-only";
import { dexSpread } from "./dex-spread";
import { cached } from "./upstream-cache";

export const RADAR_WATCHLIST: ReadonlyArray<{ symbol: string; address: string }> = [
  { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
  { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
  { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" },
  { symbol: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
  { symbol: "VIRTUAL", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
  { symbol: "DEGEN", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" },
  { symbol: "BRETT", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4" },
  { symbol: "TOSHI", address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4" },
];

export const RADAR_CACHE_SEC = 60;

export interface RadarVenue {
  dex: string | null;
  quote: string | null;
  priceUsd: number;
  liquidityUsd: number;
}

export interface RadarRow {
  symbol: string;
  address: string;
  /** ok: read. no_data: the read failed or found no priced pool — every number below is null. */
  status: "ok" | "no_data";
  reason: string | null;
  /** (dearest − cheapest) / cheapest across liquid venues, in basis points. null without ≥2 liquid venues or without data. */
  spreadBps: number | null;
  verdict: "tight" | "arb_window" | "wide" | "single_venue" | null;
  liquidVenues: number | null;
  totalVenues: number | null;
  cheapest: { dex: string | null; priceUsd: number; liquidityUsd: number } | null;
  dearest: { dex: string | null; priceUsd: number; liquidityUsd: number } | null;
  venues: RadarVenue[];
  checkedAt: string;
}

export interface RadarSnapshot {
  asOf: string;
  minLiquidityUsd: number;
  rows: RadarRow[];
}

type SpreadFn = typeof dexSpread;
type SpreadResult = Awaited<ReturnType<SpreadFn>>;

const MIN_LIQ = 5000; // dexSpread's own default floor

function toRow(t: { symbol: string; address: string }, r: PromiseSettledResult<SpreadResult>, now: string): RadarRow {
  if (r.status === "rejected") {
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return {
      symbol: t.symbol, address: t.address, status: "no_data", reason: msg.slice(0, 200),
      spreadBps: null, verdict: null, liquidVenues: null, totalVenues: null,
      cheapest: null, dearest: null, venues: [], checkedAt: now,
    };
  }
  const v = r.value;
  return {
    symbol: t.symbol,
    address: t.address,
    status: "ok",
    reason: null,
    spreadBps: typeof v.spreadPct === "number" && Number.isFinite(v.spreadPct) ? Math.round(v.spreadPct * 100) : null,
    verdict: v.verdict,
    liquidVenues: v.liquidVenues,
    totalVenues: v.totalVenues,
    cheapest: v.cheapest,
    dearest: v.dearest,
    venues: v.venues.slice(0, 5).map((p) => ({ dex: p.dex, quote: p.quote, priceUsd: p.priceUsd, liquidityUsd: p.liquidityUsd })),
    checkedAt: v.checkedAt,
  };
}

/** Uncached: one dexSpread per watchlist token, in parallel. Exported for tests (inject `spread`). */
export async function computeRadarSpreads(spread: SpreadFn = dexSpread): Promise<RadarSnapshot> {
  const results = await Promise.allSettled(
    RADAR_WATCHLIST.map((t) => spread({ address: t.address, minLiquidityUsd: String(MIN_LIQ) })),
  );
  const now = new Date().toISOString();
  return { asOf: now, minLiquidityUsd: MIN_LIQ, rows: RADAR_WATCHLIST.map((t, i) => toRow(t, results[i], now)) };
}

let inflight: Promise<RadarSnapshot | null> | null = null;

/** Cached snapshot (60s, shared through KV); concurrent misses on one instance share a single computation. */
export async function radarSpreads(): Promise<RadarSnapshot | null> {
  if (!inflight) {
    inflight = cached<RadarSnapshot>("radar:spreads:v1", RADAR_CACHE_SEC, () => computeRadarSpreads(), {
      staleGraceSec: 0,
    }).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}
