/**
 * Index health — OWNER ONLY (STATS_TOKEN gated).
 *
 * Compares what the CDP x402 Bazaar discovery index says about us against what we
 * actually serve today. Two failure modes have both bitten us in production and
 * neither is visible from our own catalog:
 *
 *  1. `missing` — a service is in our catalog but absent from discovery, so no
 *     agent browsing the Bazaar can find it. A single settled payment re-seeds it.
 *  2. `stalePrice` — discovery still advertises the price the resource had when it
 *     was last settled. Raise a price and the index keeps quoting the old one, so an
 *     agent that reads the catalog signs for too little and its payment is rejected.
 *     Discovery records only refresh on a *new* settlement, never on redeploy.
 *
 * Fix for both is the same: one paid call per affected service (see cron/index-all).
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig, getSiteUrl } from "@/lib/config";
import { safeEqual } from "@/lib/secure";
import { SERVICES } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DISCOVERY = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGE = 1000; // API caps page size at 1000
const MAX_PAGES = 40; // 40k resources — well clear of the ~14k live index
const BATCH = 3; // pages fetched in parallel

interface DiscoveryAccept {
  amount?: string;
  network?: string;
  payTo?: string;
  asset?: string;
}
interface DiscoveryItem {
  resource?: string;
  url?: string;
  lastUpdated?: string;
  accepts?: DiscoveryAccept[];
}

/** "$0.03" → 30000 (USDC has 6 decimals). Null when unparseable. */
function priceToMicro(price: string): number | null {
  const n = Number(String(price).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6);
}

const microToUsd = (micro: number) => Number((micro / 1e6).toFixed(6));

async function fetchPage(offset: number): Promise<DiscoveryItem[] | null> {
  const r = await fetch(`${DISCOVERY}?limit=${PAGE}&offset=${offset}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { items?: DiscoveryItem[] };
  return j.items ?? [];
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

  const host = new URL(getSiteUrl()).host; // e.g. 402.com.tr
  const prefix = `${getSiteUrl()}/api/x402/`;

  // Newest record per service id (a service can appear more than once, e.g. with
  // different query strings — the freshest one is what agents see quoted).
  const seen = new Map<string, { lastUpdated: string; accept: DiscoveryAccept; resource: string }>();
  let scanned = 0;
  let truncated = true;

  for (let page = 0; page < MAX_PAGES; page += BATCH) {
    const pages = await Promise.all(
      Array.from({ length: BATCH }, (_, i) => fetchPage((page + i) * PAGE)),
    );
    let empty = false;
    for (const items of pages) {
      if (items === null) {
        return NextResponse.json(
          { error: "CDP discovery API unavailable", scanned },
          { status: 502 },
        );
      }
      if (items.length === 0) {
        empty = true;
        continue;
      }
      scanned += items.length;
      for (const it of items) {
        const resource = it.resource ?? it.url ?? "";
        if (typeof resource !== "string" || !resource.includes(host)) continue;
        const id = resource.startsWith(prefix)
          ? resource.slice(prefix.length).split("?")[0]
          : (resource.match(/\/api\/x402\/([\w-]+)/)?.[1] ?? "");
        if (!id) continue;
        const lastUpdated = it.lastUpdated ?? "";
        const prev = seen.get(id);
        if (!prev || lastUpdated > prev.lastUpdated) {
          seen.set(id, { lastUpdated, accept: (it.accepts ?? [])[0] ?? {}, resource });
        }
      }
    }
    if (empty) {
      truncated = false;
      break;
    }
  }

  const missing: Array<{ id: string; price: string; hidden?: boolean }> = [];
  const stalePrice: Array<{
    id: string;
    indexedUsd: number | null;
    liveUsd: number | null;
    lastUpdated: string;
    underQuoted: boolean;
  }> = [];
  const wrongPayTo: Array<{ id: string; indexedPayTo: string }> = [];

  for (const s of SERVICES) {
    const rec = seen.get(s.id);
    if (!rec) {
      missing.push({ id: s.id, price: s.price, ...(s.hidden ? { hidden: true } : {}) });
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
    if (payTo && cfg.payTo && payTo !== cfg.payTo.toLowerCase()) {
      wrongPayTo.push({ id: s.id, indexedPayTo: payTo });
    }
  }

  // Indexed under our host but no longer in the catalog (renamed / retired ids).
  const orphans = [...seen.keys()].filter((id) => !SERVICES.some((s) => s.id === id));

  const reseedCostUsd = Number(
    [...missing, ...stalePrice]
      .reduce((sum, row) => {
        const id = row.id;
        const svc = SERVICES.find((s) => s.id === id);
        return sum + (svc ? (priceToMicro(svc.price) ?? 0) / 1e6 : 0);
      }, 0)
      .toFixed(4),
  );

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    scanned,
    truncated, // true → hit MAX_PAGES before the index ended; counts are a floor
    catalog: SERVICES.length,
    indexed: seen.size,
    missingCount: missing.length,
    stalePriceCount: stalePrice.length,
    underQuotedCount: stalePrice.filter((r) => r.underQuoted).length,
    reseedCostUsd, // one paid call per affected service fixes both classes
    missing,
    stalePrice: stalePrice.sort((a, b) => (a.id < b.id ? -1 : 1)),
    wrongPayTo,
    orphans,
    note:
      "Discovery records refresh only on a new successful settlement. After a price change, " +
      "re-settle the service once or the index keeps quoting the old amount.",
  });
}
