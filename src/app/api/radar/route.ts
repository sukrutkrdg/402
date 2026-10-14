/**
 * GET /api/radar — cross-DEX spreads for a fixed Base watchlist (src/lib/radar.ts,
 * the real dexSpread logic, cached 60s) plus recently fired alerts, as recorded
 * at the moment they fired (src/lib/live-events.ts).
 *
 * No invented events: an empty `alerts` list means nothing fired recently.
 */

import { NextResponse } from "next/server";
import { radarSpreads, RADAR_CACHE_SEC } from "@/lib/radar";
import { readAlertFirings } from "@/lib/live-events";

export const dynamic = "force-dynamic";

const RADAR_METHOD = {
  spreads: `Per token: DexScreener pools on Base where the token is the base asset, compared across venues with at least $5,000 liquidity (the dex-spread service's logic). spreadBps is null when fewer than two venues clear that floor, and every number is null when the token could not be read (status "no_data"). Snapshot cached ${RADAR_CACHE_SEC}s.`,
  alerts:
    "Price alerts and rug-watch monitors registered by our customers, recorded when our cron saw the threshold crossed (checked every 10 minutes). A rug_warning means a watched pool's liquidity fell past the subscriber's threshold — a measured liquidity move, not a verdict that the token is a scam. Alert ids, webhooks and subscribers are never shown.",
  scanFlags:
    "Not shown: the token-scout cron does not persist its scan results (it keeps only a 7-day seen-marker per token), so there is nothing recorded to surface.",
};

export async function GET() {
  const [spreads, alerts] = await Promise.all([
    radarSpreads().catch(() => null),
    readAlertFirings(20).catch(() => []),
  ]);
  return NextResponse.json(
    { spreads, alerts, method: RADAR_METHOD },
    { headers: { "Cache-Control": `public, s-maxage=${RADAR_CACHE_SEC}, stale-while-revalidate=${RADAR_CACHE_SEC}` } },
  );
}
