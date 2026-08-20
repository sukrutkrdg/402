/**
 * Index health — OWNER ONLY (STATS_TOKEN gated).
 *
 * Compares what the CDP x402 Bazaar discovery index says about us against what we
 * actually serve today. Three failure modes have all bitten us in production and
 * none is visible from our own catalog:
 *
 *  1. `missing` — a service is in our catalog but absent from discovery, so no
 *     agent browsing the Bazaar can find it. A single settled payment re-seeds it.
 *  2. `stalePrice` — discovery still advertises the price the resource had when it
 *     was last settled. Raise a price and the index keeps quoting the old one, so an
 *     agent that reads the catalog signs for too little and its payment is rejected.
 *     Discovery records only refresh on a *new* settlement, never on redeploy.
 *  3. `expiringSoon` — the catalog evicts a resource 30 days after its stored
 *     `lastCalledAt`, on a daily conveyor. A row nobody has paid for in 30 days
 *     leaves on its own, whatever we serve. See the eviction note below.
 *
 * Fix for all three is the same: one paid call per affected service (cron/index-all).
 *
 * WHY THIS READS `search?payTo=` AND NOT THE FULL SWEEP
 * -----------------------------------------------------
 * It used to page `/discovery/resources` and look for our host among ~15k rows.
 * That instrument has a documented way of lying (x402-foundation/x402#3045):
 * `limit` is silently rounded to the nearest ten and capped at 1000, and paging
 * keys on `offset // effective_limit` rather than the raw offset — so a scan
 * whose stride does not match its effective page size never requests whole
 * pages, and every healthy row on them reads as absent. Our stride happened to
 * be aligned (limit=1000, offsets at exact multiples), so we were not being
 * bitten. "Happened to be" is not a property worth relying on for the check that
 * tells us whether anyone can find us.
 *
 * `search?payTo=` answers about our own rows directly, with no offset stepping
 * and no way to skip a page. What it cannot do is enumerate: `limit` maxes at 20
 * (21 is a 400), `offset` is ignored, and the `meta.searchToken` is regenerated
 * per request rather than being a cursor — all measured, not assumed. So we ask
 * one narrow question per service instead of one broad one for all of them.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig, getSiteUrl } from "@/lib/config";
import { safeEqual } from "@/lib/secure";
import { SERVICES } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SEARCH = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";
/** Concurrent queries. One per service, so this is the whole runtime knob. */
const BATCH = 8;
/**
 * Days from stored `lastCalledAt` to eviction. Established on the thread from
 * one night of natural tape (42 of 42 unexplained-free) and then from a
 * pre-registered prediction of 23 routes scored 22 hit / 1 censored / 0 miss,
 * with origin-side probes confirming the sellers were still serving. Our
 * keepalive cron re-settles at 21 days, comfortably inside it.
 */
const EVICTION_DAYS = 30;

interface DiscoveryAccept {
  amount?: string;
  network?: string;
  payTo?: string;
  asset?: string;
}
interface DiscoveryResource {
  resource?: string;
  url?: string;
  lastUpdated?: string;
  accepts?: DiscoveryAccept[];
  quality?: { lastCalledAt?: string; l30DaysTotalCalls?: number; l30DaysUniquePayers?: number };
}
interface Row {
  lastUpdated: string;
  accept: DiscoveryAccept;
  lastCalledAt: string | null;
  calls30d: number | null;
}

/** "$0.03" → 30000 (USDC has 6 decimals). Null when unparseable. */
function priceToMicro(price: string): number | null {
  const n = Number(String(price).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6);
}

const microToUsd = (micro: number) => Number((micro / 1e6).toFixed(6));

/**
 * Every row the index holds for `payTo` that matches this query text.
 * Null means we could not ask — which is never the same as an empty answer.
 */
async function search(payTo: string, query: string): Promise<DiscoveryResource[] | null> {
  const url = `${SEARCH}?payTo=${encodeURIComponent(payTo)}&query=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = (await r.json()) as { resources?: DiscoveryResource[] };
        return j.resources ?? [];
      }
    } catch {
      /* transport — retry once */
    }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 250));
  }
  return null;
}

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const provided = req.headers.get("x-stats-token") || "";
  if (!cfg.statsToken) {
    return NextResponse.json({ error: "Locked. Set STATS_TOKEN to enable." }, { status: 503 });
  }
  if (!safeEqual(provided, cfg.statsToken)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!cfg.payTo) {
    return NextResponse.json({ error: "PAY_TO_ADDRESS is not set — nothing to look up." }, { status: 503 });
  }

  const host = new URL(getSiteUrl()).host; // e.g. 402.com.tr
  const prefix = `${getSiteUrl()}/api/x402/`;
  const idOf = (resource: string): string =>
    resource.startsWith(prefix)
      ? resource.slice(prefix.length).split("?")[0]
      : (resource.match(/\/api\/x402\/([\w-]+)/)?.[1] ?? "");

  // Newest record per service id. A fuzzy query returns neighbours too, and they
  // are all ours (payTo filter), so everything gets folded in — one query's
  // by-catch is another service's answer, and the union doubles as our best view
  // of what the index holds for us.
  const seen = new Map<string, Row>();
  const unchecked: string[] = [];
  let queries = 0;

  const absorb = (rows: DiscoveryResource[]) => {
    for (const it of rows) {
      const resource = it.resource ?? it.url ?? "";
      if (typeof resource !== "string" || !resource.includes(host)) continue;
      const id = idOf(resource);
      if (!id) continue;
      const lastUpdated = it.lastUpdated ?? "";
      const prev = seen.get(id);
      if (!prev || lastUpdated > prev.lastUpdated) {
        seen.set(id, {
          lastUpdated,
          accept: (it.accepts ?? [])[0] ?? {},
          lastCalledAt: it.quality?.lastCalledAt ?? null,
          calls30d: it.quality?.l30DaysTotalCalls ?? null,
        });
      }
    }
  };

  for (let i = 0; i < SERVICES.length; i += BATCH) {
    const slice = SERVICES.slice(i, i + BATCH);
    const results = await Promise.all(slice.map((s) => search(cfg.payTo, s.id)));
    results.forEach((rows, k) => {
      queries++;
      // A query that failed tells us nothing about that service. Letting it fall
      // through to `missing` would report an outage as a delisting and send the
      // cron out to pay for a re-seed nothing needed.
      if (rows === null) unchecked.push(slice[k].id);
      else absorb(rows);
    });
  }

  const uncheckedSet = new Set(unchecked);
  const now = Date.now();

  const missing: Array<{ id: string; price: string; hidden?: boolean }> = [];
  const stalePrice: Array<{ id: string; indexedUsd: number | null; liveUsd: number | null; lastUpdated: string; underQuoted: boolean }> = [];
  const wrongPayTo: Array<{ id: string; indexedPayTo: string }> = [];
  const expiringSoon: Array<{ id: string; lastCalledAt: string; evictsAt: string; daysLeft: number }> = [];

  for (const s of SERVICES) {
    const rec = seen.get(s.id);
    if (!rec) {
      // Only call it missing if we actually got an answer about it. A service
      // whose own query failed can still be present in the index.
      if (!uncheckedSet.has(s.id)) {
        missing.push({ id: s.id, price: s.price, ...(s.hidden ? { hidden: true } : {}) });
      }
      continue;
    }
    const liveMicro = priceToMicro(s.price);
    const idxMicro = rec.accept.amount ? Number(rec.accept.amount) : null;
    if (liveMicro !== null && idxMicro !== null && idxMicro !== liveMicro) {
      stalePrice.push({
        id: s.id,
        indexedUsd: microToUsd(idxMicro),
        liveUsd: microToUsd(liveMicro),
        lastUpdated: rec.lastUpdated,
        // The one that actually breaks purchases: index quotes less than we charge,
        // so a catalog-driven agent signs for too little and gets rejected.
        underQuoted: idxMicro < liveMicro,
      });
    }
    const payTo = rec.accept.payTo?.toLowerCase();
    if (payTo && payTo !== cfg.payTo.toLowerCase()) {
      wrongPayTo.push({ id: s.id, indexedPayTo: payTo });
    }
    if (rec.lastCalledAt) {
      const evicts = Date.parse(rec.lastCalledAt) + EVICTION_DAYS * 86400_000;
      const daysLeft = Math.floor((evicts - now) / 86400_000);
      if (Number.isFinite(daysLeft) && daysLeft <= 10) {
        expiringSoon.push({ id: s.id, lastCalledAt: rec.lastCalledAt, evictsAt: new Date(evicts).toISOString(), daysLeft });
      }
    }
  }

  // Indexed under our host but not in the catalog (renamed / retired ids). The
  // search path cannot enumerate, so this is what 132 narrow queries happened to
  // surface — a floor, not an inventory, and named so it cannot be read as one.
  const orphansSeen = [...seen.keys()].filter((id) => !SERVICES.some((s) => s.id === id));

  const reseedCostUsd = Number(
    [...missing, ...stalePrice]
      .reduce((sum, row) => {
        const svc = SERVICES.find((s) => s.id === row.id);
        return sum + (svc ? (priceToMicro(svc.price) ?? 0) / 1e6 : 0);
      }, 0)
      .toFixed(4),
  );

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    method: "discovery/search?payTo — one targeted query per service",
    queries,
    catalog: SERVICES.length,
    indexedSeen: seen.size,
    // Non-empty means the counts below are a floor: these services were not
    // answered for, and none of them is being called missing on that basis.
    uncheckedCount: unchecked.length,
    ...(unchecked.length > 0 ? { unchecked } : {}),
    degraded: unchecked.length > 0,
    missingCount: missing.length,
    stalePriceCount: stalePrice.length,
    underQuotedCount: stalePrice.filter((r) => r.underQuoted).length,
    expiringSoonCount: expiringSoon.length,
    reseedCostUsd, // one paid call per affected service fixes missing + stalePrice
    missing,
    stalePrice: stalePrice.sort((a, b) => (a.id < b.id ? -1 : 1)),
    expiringSoon: expiringSoon.sort((a, b) => a.daysLeft - b.daysLeft),
    wrongPayTo,
    orphansSeen,
    note:
      "Discovery records refresh only on a new successful settlement. After a price change, " +
      `re-settle the service once or the index keeps quoting the old amount. Eviction runs at ` +
      `lastCalledAt + ${EVICTION_DAYS}d on a daily conveyor, so anything in expiringSoon needs a ` +
      "settlement before its evictsAt or it leaves the index on its own.",
  });
}
