/**
<<<<<<< HEAD
 * watchlist-diff — "what changed on my tokens since my last paid check?"
 *
 * Retention engineered into the product: the first call snapshots up to 10 tokens
 * and returns a watchId; every later call with that watchId returns only the
 * DELTAS (liquidity ±%, price ±%, honeypot/tax flipped) and re-snapshots — so the
 * second call is intrinsically more valuable than the first. Built on the cached
 * upstreams (DexScreener pairs + GoPlus security), so a 10-token diff is cheap.
 *
 * Failure discipline: an upstream outage is UNKNOWN, never zero. Coercing a
 * DexScreener blip to liq=0 would fire the worst possible false alert
 * ("LIQUIDITY_DOWN_100%") and then persist the zeroed baseline, poisoning every
 * later diff — so unavailable fields stay null, produce no alerts, and never
 * overwrite the stored baseline.
 */

import "server-only";
import { randomBytes } from "node:crypto";
import { kvGet, kvSet, kvConfigured } from "./kv";
import { dexTokenPairs, goPlusSecurity } from "./upstream-cache";

interface Snap {
  liq: number | null;
  price: number | null;
  honeypot: boolean | null;
  sellTax: number | null;
}
interface Watch {
  id: string;
  tokens: string[];
  snaps: Record<string, Snap>;
=======
 * Watchlist Diff — "what changed across my tokens since I last looked?"
 *
 * Pay once to register up to 10 tokens; every later call with id=<id> returns
 * the per-token delta (price / liquidity) versus YOUR previous check plus
 * threshold alerts (liquidity drain, dump, market gone) — one call instead of
 * 10 price checks and client-side bookkeeping. Snapshots live in KV per
 * watchlist id, so a stateless agent gets stateful monitoring.
 */

import "server-only";
import { kvGet, kvSet, kvConfigured } from "./kv";
import { dexScreenerTokenPairs } from "./upstream-cache";

const TTL = 60 * 60 * 24 * 30; // 30 days, refreshed on every check

interface TokenSnap {
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  /** No Base DEX pair found (delisted / drained / never listed). */
  noMarket?: boolean;
}

interface Watchlist {
  id: string;
  tokens: string[];
  snaps: Record<string, TokenSnap>;
>>>>>>> 40b543d (Add upstream cache, watchlist, whale flow modules)
  createdAt: string;
  updatedAt: string;
}

<<<<<<< HEAD
const TTL = 60 * 60 * 24 * 30;
const num = (v: unknown) => {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

async function snapshot(token: string): Promise<Snap> {
  const t = token.toLowerCase();
  // null = provider unavailable (unknown); [] = provider answered "no pairs".
  const rawPairs = await dexTokenPairs<{ baseToken?: { address?: string }; liquidity?: { usd?: number }; priceUsd?: string }>(t);
  const pairs = rawPairs === null ? null : rawPairs.filter((p) => p.baseToken?.address?.toLowerCase() === t);
  const best = pairs === null ? null : pairs.reduce((m, p) => ((p.liquidity?.usd ?? 0) > (m?.liquidity?.usd ?? 0) ? p : m), pairs[0]);
  const gp = (await goPlusSecurity<{ is_honeypot?: string; sell_tax?: string }>(t)) ?? null;
  return {
    liq: pairs === null ? null : Math.round(best?.liquidity?.usd ?? 0),
    price: pairs === null ? null : num(best?.priceUsd),
    honeypot: gp === null ? null : gp.is_honeypot === "1",
    sellTax: gp === null ? null : +(num(gp.sell_tax) * 100).toFixed(1),
  };
}

const pctChange = (from: number, to: number) => (from > 0 ? +(((to - from) / from) * 100).toFixed(1) : to > 0 ? 100 : 0);

export async function watchlistDiff(params: Record<string, string>) {
  if (!kvConfigured()) throw new Error("Watchlist unavailable: durable storage not configured");
  const watchId = (params.watchId || params.watch || "").trim();

  // ---- Re-check mode: diff against the stored snapshot ----
  if (watchId) {
    const raw = await kvGet(`watch:${watchId}`);
    if (!raw) return { found: false, note: "No watchlist with that id (expired or never created). Create one by passing tokens=." };
    const w = JSON.parse(raw) as Watch;
    const changes = [];
    let anyDegraded = false;
    for (const token of w.tokens) {
      const prev = w.snaps[token];
      const now = await snapshot(token);
      const degraded: string[] = [];
      if (now.liq === null) degraded.push("dex");
      if (now.honeypot === null) degraded.push("security");
      if (degraded.length) anyDegraded = true;

      // Deltas/alerts only where BOTH sides are known — an outage is not a change.
      const liqPct = prev?.liq != null && now.liq !== null ? pctChange(prev.liq, now.liq) : null;
      const pricePct = prev?.price != null && now.price !== null ? pctChange(prev.price, now.price) : null;
      const flags = [];
      if (prev?.honeypot === false && now.honeypot === true) flags.push("BECAME_HONEYPOT");
      if (prev?.sellTax != null && now.sellTax !== null && prev.sellTax < 20 && now.sellTax >= 20) flags.push(`SELL_TAX_UP_${now.sellTax}%`);
      if (liqPct !== null && liqPct <= -30) flags.push(`LIQUIDITY_DOWN_${Math.abs(liqPct)}%`);
      changes.push({
        token,
        liquidityUsd: now.liq, liquidityChangePct: liqPct,
        priceUsd: now.price, priceChangePct: pricePct,
        honeypot: now.honeypot, sellTaxPct: now.sellTax,
        alerts: flags,
        changed: flags.length > 0 || (liqPct !== null && Math.abs(liqPct) >= 10) || (pricePct !== null && Math.abs(pricePct) >= 10),
        ...(degraded.length ? { unavailable: degraded } : {}),
      });
      // Advance the baseline ONLY for fields we actually read; keep the previous
      // known value where the provider was down so the next diff stays honest.
      w.snaps[token] = {
        liq: now.liq ?? prev?.liq ?? null,
        price: now.price ?? prev?.price ?? null,
        honeypot: now.honeypot ?? prev?.honeypot ?? null,
        sellTax: now.sellTax ?? prev?.sellTax ?? null,
      };
    }
    w.updatedAt = new Date().toISOString();
    await kvSet(`watch:${watchId}`, JSON.stringify(w), TTL);
    const material = changes.filter((c) => c.alerts.length > 0);
    return {
      watchId, sinceLast: true, tokenCount: w.tokens.length,
      materialAlerts: material.length,
      changes,
      ...(anyDegraded ? { degraded: true } : {}),
      note: material.length
        ? `⚠️ ${material.length} token(s) changed materially since your last check.`
        : anyDegraded
          ? "No material changes detected, but a data provider was unavailable for some fields (marked 'unavailable') — those were not compared. Re-check shortly."
          : "No material changes since your last check. Re-check anytime with watchId.",
      checkedAt: new Date().toISOString(),
    };
  }

  // ---- Create mode: snapshot a new watchlist ----
  const tokens = (params.tokens || params.addresses || "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s))
    .slice(0, 10);
  if (tokens.length === 0) throw new Error("Provide up to 10 comma-separated token addresses (tokens=), or a watchId= to re-check.");

  const snaps: Record<string, Snap> = {};
  for (const t of tokens) snaps[t] = await snapshot(t);
  // A baseline built while BOTH providers are down is worthless — refuse (≥400 →
  // the buyer is not charged) rather than selling an empty snapshot.
  if (tokens.every((t) => snaps[t].liq === null && snaps[t].honeypot === null))
    throw new Error("Upstream data providers unavailable — could not build a baseline, try again shortly");
  const id = `wl_${randomBytes(9).toString("hex")}`;
  const w: Watch = { id, tokens, snaps, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await kvSet(`watch:${id}`, JSON.stringify(w), TTL);

  return {
    watchId: id, created: true, tokenCount: tokens.length,
    baseline: tokens.map((t) => ({ token: t, ...snaps[t] })),
    note: `Watchlist created. Re-check anytime by calling this service with watchId=${id} — you'll get only what changed (liquidity/price/honeypot/tax) since the last check. Expires in 30 days.`,
    checkedAt: new Date().toISOString(),
=======
interface DsPair {
  baseToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
}

const validAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/** Current snapshot for one token; null = upstream unreachable (keep old snap). */
async function snapToken(addr: string): Promise<TokenSnap | null> {
  const j = await dexScreenerTokenPairs<{ pairs?: DsPair[] | null }>(addr);
  if (!j) return null;
  const pairs = (j.pairs ?? []).filter((p) => p.baseToken?.address?.toLowerCase() === addr);
  if (pairs.length === 0) return { priceUsd: null, liquidityUsd: null, volume24hUsd: null, noMarket: true };
  const best = pairs.reduce((a, p) => ((p.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? p : a), pairs[0]);
  const price = parseFloat(best.priceUsd ?? "");
  return {
    priceUsd: Number.isFinite(price) ? price : null,
    liquidityUsd: best.liquidity?.usd ?? null,
    volume24hUsd: best.volume?.h24 ?? null,
  };
}

const pctChange = (prev: number | null | undefined, cur: number | null): number | null =>
  prev != null && prev > 0 && cur != null ? +(100 * (cur / prev - 1)).toFixed(2) : null;

export async function watchlistDiff(params: Record<string, string>) {
  if (!kvConfigured()) throw new Error("Watchlist unavailable: durable storage not configured");

  const id = (params.id || "").trim();
  const tokensRaw = (params.tokens || "").trim();

  // ---- Re-check mode: diff against the caller's previous snapshot ----
  if (id) {
    const raw = await kvGet(`watchdiff:${id}`);
    if (!raw) return { found: false, note: "No watchlist with that id (expired or never registered). Register with tokens=0x…,0x…" };
    const wl = JSON.parse(raw) as Watchlist;

    const results = [];
    let alertTotal = 0;
    for (const t of wl.tokens) {
      const prev = wl.snaps[t];
      const cur = await snapToken(t);
      if (cur === null) {
        // Upstream miss for this token: report it, keep the old snapshot.
        results.push({ address: t, skipped: true, note: "Price source unreachable for this token right now — previous snapshot kept." });
        continue;
      }
      const pricePct = pctChange(prev?.priceUsd, cur.priceUsd);
      const liquidityPct = pctChange(prev?.liquidityUsd, cur.liquidityUsd);
      const alerts: string[] = [];
      if (prev && !prev.noMarket && cur.noMarket) alerts.push("MARKET_GONE");
      if (liquidityPct !== null && liquidityPct <= -30) alerts.push("LIQUIDITY_DRAIN");
      if (pricePct !== null && pricePct <= -20) alerts.push("PRICE_DUMP");
      if (pricePct !== null && pricePct >= 20) alerts.push("PRICE_PUMP");
      alertTotal += alerts.filter((a) => a !== "PRICE_PUMP").length;
      results.push({
        address: t,
        current: cur,
        previous: prev ?? null,
        change: { pricePct, liquidityPct },
        alerts,
      });
      wl.snaps[t] = cur; // roll the baseline forward to THIS check
    }

    const sinceLastCheck = wl.updatedAt;
    wl.updatedAt = new Date().toISOString();
    await kvSet(`watchdiff:${id}`, JSON.stringify(wl), TTL);

    return {
      found: true,
      id,
      tokenCount: wl.tokens.length,
      sinceLastCheck,
      tokens: results,
      alertCount: alertTotal,
      verdict: alertTotal > 0 ? "CHANGES_NEED_ATTENTION" : "ok",
      note: "Deltas are versus YOUR previous check (baseline rolls forward each call). Re-check anytime with id=<id>; the watchlist expires after 30 idle days.",
      checkedAt: wl.updatedAt,
    };
  }

  // ---- Register mode: baseline snapshot for up to 10 tokens ----
  const tokens = [...new Set(tokensRaw.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(validAddr))].slice(0, 10);
  if (tokens.length === 0) throw new Error("Provide tokens=0x…,0x… (up to 10 Base token addresses) to register, or id=<id> to re-check");

  const snaps: Record<string, TokenSnap> = {};
  for (const t of tokens) {
    const s = await snapToken(t);
    if (s) snaps[t] = s;
  }
  if (Object.keys(snaps).length === 0) throw new Error("Price data unavailable for all provided tokens — nothing to baseline");

  const now = new Date().toISOString();
  const wid = `wd_${crypto.randomUUID().slice(0, 12)}`;
  const wl: Watchlist = { id: wid, tokens, snaps, createdAt: now, updatedAt: now };
  await kvSet(`watchdiff:${wid}`, JSON.stringify(wl), TTL);

  return {
    registered: true,
    id: wid,
    tokenCount: tokens.length,
    baseline: snaps,
    note: `Baseline stored for ${tokens.length} token(s). Call again with id=${wid} to get what changed since this check — price/liquidity deltas + LIQUIDITY_DRAIN / PRICE_DUMP / MARKET_GONE alerts.`,
    createdAt: now,
>>>>>>> 40b543d (Add upstream cache, watchlist, whale flow modules)
  };
}
