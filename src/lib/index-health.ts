/**
 * What the CDP x402 Bazaar discovery index says about us, against what we serve.
 *
 * Four failure modes have all bitten us in production and none is visible from
 * our own catalog:
 *
 *  1. `missing` — a service is in our catalog but absent from discovery, so no
 *     agent browsing the Bazaar can find it. A single settled payment re-seeds it.
 *  2. `stalePrice` — discovery still advertises the price the resource had when it
 *     was last settled. Raise a price and the index keeps quoting the old one, so an
 *     agent that reads the catalog signs for too little and its payment is rejected.
 *     Discovery records only refresh on a *new* settlement, never on redeploy.
 *  3. `staleNetworks` — the same freeze, applied to the chain list. Polygon was
 *     added to `accepts` on 2026-08-30; on 2026-09-03 only 7 of 67 indexed rows
 *     advertised it, and those 7 were exactly the ones settled after the deploy.
 *     A chain nobody can see is a chain nobody can choose, so the measurement
 *     asking whether anyone paid on Polygon was reading a catalogue that had
 *     never offered it to 90% of its callers.
 *  4. `expiringSoon` — the catalog evicts a resource 30 days after its stored
 *     `lastCalledAt`, on a daily conveyor. A row nobody has paid for in 30 days
 *     leaves on its own, whatever we serve.
 *
 * Fix for all four is the same: one paid call per affected service (cron/index-all).
 *
 * This lives in lib rather than in the route because two callers need it and
 * they must not drift: the owner-only route renders it, and cron/index-gap
 * raises an incident from it. A second implementation is how the two payment
 * rails came to quote different prices once already.
 *
 * WHY THIS READS `search?payTo=` AND NOT THE FULL SWEEP
 * -----------------------------------------------------
 * It used to page `/discovery/resources` and look for our host among ~15k rows.
 * That instrument has a documented way of lying (x402-foundation/x402#3045):
 * `limit` is silently rounded to the nearest ten and capped at 1000, and paging
 * keys on `offset // effective_limit` rather than the raw offset — so a scan
 * whose stride does not match its effective page size never requests whole
 * pages, and every healthy row on them reads as absent. Our stride happened to
 * be aligned, so we were not being bitten. "Happened to be" is not a property
 * worth relying on for the check that tells us whether anyone can find us.
 *
 * `search?payTo=` answers about our own rows directly, with no offset stepping
 * and no way to skip a page. What it cannot do is enumerate: `limit` maxes at 20
 * (21 is a 400), `offset` is ignored, and the `meta.searchToken` is regenerated
 * per request rather than being a cursor — all measured, not assumed. So we ask
 * one narrow question per service instead of one broad one for all of them.
 */

import "server-only";
import { ALL_NETWORKS } from "./config";
import { SERVICES } from "./services";

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
export const EVICTION_DAYS = 30;

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
  /**
   * EVERY network the index advertises for this resource, not just the first
   * accept's. A row can quote the right price on the wrong set of chains, and
   * only the whole list shows it.
   */
  networks: string[];
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

export interface IndexHealth {
  checkedAt: string;
  method: string;
  queries: number;
  catalog: number;
  indexedSeen: number;
  uncheckedCount: number;
  unchecked?: string[];
  degraded: boolean;
  missingCount: number;
  stalePriceCount: number;
  underQuotedCount: number;
  staleNetworksCount: number;
  expiringSoonCount: number;
  serve: string[];
  reseedCount: number;
  reseedCostUsd: number;
  missing: Array<{ id: string; price: string; hidden?: boolean }>;
  stalePrice: Array<{ id: string; indexedUsd: number | null; liveUsd: number | null; lastUpdated: string; underQuoted: boolean }>;
  staleNetworks: Array<{ id: string; indexed: string[]; missingNetworks: string[]; lastUpdated: string }>;
  expiringSoon: Array<{ id: string; lastCalledAt: string; evictsAt: string; daysLeft: number }>;
  wrongPayTo: Array<{ id: string; indexedPayTo: string }>;
  orphansSeen: string[];
  note: string;
}

export async function checkIndexHealth(payTo: string, siteUrl: string): Promise<IndexHealth> {
  const host = new URL(siteUrl).host; // e.g. 402.com.tr
  const prefix = `${siteUrl}/api/x402/`;
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
          networks: (it.accepts ?? []).map((a) => a.network).filter((n): n is string => Boolean(n)),
          lastCalledAt: it.quality?.lastCalledAt ?? null,
          calls30d: it.quality?.l30DaysTotalCalls ?? null,
        });
      }
    }
  };

  for (let i = 0; i < SERVICES.length; i += BATCH) {
    const slice = SERVICES.slice(i, i + BATCH);
    const results = await Promise.all(slice.map((s) => search(payTo, s.id)));
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

  const missing: IndexHealth["missing"] = [];
  const stalePrice: IndexHealth["stalePrice"] = [];
  const wrongPayTo: IndexHealth["wrongPayTo"] = [];
  const expiringSoon: IndexHealth["expiringSoon"] = [];
  const staleNetworks: IndexHealth["staleNetworks"] = [];

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
    const indexedPayTo = rec.accept.payTo?.toLowerCase();
    if (indexedPayTo && indexedPayTo !== payTo.toLowerCase()) {
      wrongPayTo.push({ id: s.id, indexedPayTo });
    }
    // Only flag chains we serve but the index does not advertise. An extra
    // network in the index is not a fault we can act on here — dropping support
    // is the deliberate case, and it clears itself on the next settlement.
    const absent = ALL_NETWORKS.filter((n) => !rec.networks.includes(n));
    if (rec.networks.length > 0 && absent.length > 0) {
      staleNetworks.push({ id: s.id, indexed: rec.networks, missingNetworks: absent, lastUpdated: rec.lastUpdated });
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
  // search path cannot enumerate, so this is what the narrow queries happened to
  // surface — a floor, not an inventory, and named so it cannot be read as one.
  const orphansSeen = [...seen.keys()].filter((id) => !SERVICES.some((s) => s.id === id));

  // One settlement fixes every one of these for a given service, so a service
  // that is both mispriced and on the wrong chains must be counted once.
  const needsReseed = [...new Set([...missing, ...stalePrice, ...staleNetworks].map((r) => r.id))];
  const reseedCostUsd = Number(
    needsReseed
      .reduce((sum, id) => {
        const svc = SERVICES.find((s) => s.id === id);
        return sum + (svc ? (priceToMicro(svc.price) ?? 0) / 1e6 : 0);
      }, 0)
      .toFixed(4),
  );

  return {
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
    staleNetworksCount: staleNetworks.length,
    expiringSoonCount: expiringSoon.length,
    serve: ALL_NETWORKS,
    reseedCount: needsReseed.length,
    reseedCostUsd, // one paid call per affected service fixes all three
    missing,
    stalePrice: stalePrice.sort((a, b) => (a.id < b.id ? -1 : 1)),
    staleNetworks: staleNetworks.sort((a, b) => (a.id < b.id ? -1 : 1)),
    expiringSoon: expiringSoon.sort((a, b) => a.daysLeft - b.daysLeft),
    wrongPayTo,
    orphansSeen,
    note:
      "Discovery records refresh only on a new successful settlement. After a price change, " +
      `re-settle the service once or the index keeps quoting the old amount. The same is true of ` +
      "the chain list: a network added to `accepts` reaches the index one settlement at a time, so " +
      "until then an agent reading the catalogue cannot choose it — which makes any 'nobody paid on " +
      `chain X' measurement meaningless while staleNetworks is non-empty. Eviction runs at ` +
      `lastCalledAt + ${EVICTION_DAYS}d on a daily conveyor, so anything in expiringSoon needs a ` +
      "settlement before its evictsAt or it leaves the index on its own.",
  };
}

/**
 * The subset that needs a human, and the reason it does.
 *
 * Deliberately NOT every non-zero count. `staleNetworks` sits at 125 today
 * because Polygon reaches the index one settlement at a time and the keepalive
 * cron works through it over three weeks — alerting on that would page daily
 * about a backlog that is already draining itself, and an alert that fires every
 * morning becomes a filter rule before it becomes an action.
 *
 * `degraded` is excluded for the opposite reason: when queries failed we do not
 * know what is wrong, and "we could not look" is not a finding.
 */
export function indexHealthProblems(h: IndexHealth): string[] {
  const problems: string[] = [];
  if (h.missingCount > 0) {
    problems.push(
      `${h.missingCount} service(s) absent from discovery — no agent browsing the Bazaar can find them: ${h.missing.map((m) => m.id).join(", ")}`,
    );
  }
  if (h.underQuotedCount > 0) {
    const under = h.stalePrice.filter((r) => r.underQuoted);
    problems.push(
      `${under.length} service(s) quoted BELOW what we charge, so a catalogue-driven agent signs for too little and its payment is rejected: ${under.map((r) => `${r.id} (index $${r.indexedUsd}, live $${r.liveUsd})`).join(", ")}`,
    );
  }
  if (h.wrongPayTo.length > 0) {
    problems.push(`${h.wrongPayTo.length} row(s) advertise a payTo that is not ours: ${h.wrongPayTo.map((r) => r.id).join(", ")}`);
  }
  if (h.expiringSoonCount > 0) {
    problems.push(
      `${h.expiringSoonCount} row(s) leave the index within 10 days unless re-settled: ${h.expiringSoon.map((r) => `${r.id} (${r.daysLeft}d)`).join(", ")}`,
    );
  }
  return problems;
}
