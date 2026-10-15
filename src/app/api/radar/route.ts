/**
 * GET /api/radar — cross-DEX spreads for a fixed Base watchlist (src/lib/radar.ts,
 * the real dexSpread logic, cached 60s), recently fired alerts as recorded at
 * the moment they fired, and the latest token-scout scans as recorded by the
 * cron (both src/lib/live-events.ts).
 *
 * No invented events: an empty `alerts` or `scans` list means nothing was recorded recently.
 */

import { NextResponse } from "next/server";
import { radarSpreads, RADAR_CACHE_SEC } from "@/lib/radar";
import { publicScan, readAlertFirings, readScans } from "@/lib/live-events";

export const dynamic = "force-dynamic";

const RADAR_SCANS = 25;

const RADAR_METHOD = {
  spreads: `Per token: DexScreener pools on Base where the token is the base asset, compared across venues with at least $5,000 liquidity (the dex-spread service's logic). A thin pool priced more than 3% from the liquidity-weighted median is set aside rather than allowed to set the spread (thinOutliers counts them). spreadBps is null when fewer than two venues remain, and every number is null when the token could not be read (status "no_data"). Snapshot cached ${RADAR_CACHE_SEC}s.`,
  alerts:
    "Price alerts and rug-watch monitors registered by our customers, recorded when our cron saw the threshold crossed (checked every 10 minutes). A rug_warning means a watched pool's liquidity fell past the subscriber's threshold — a measured liquidity move, not a verdict that the token is a scam. Alert ids, webhooks and subscribers are never shown.",
  scanFlags:
    "What our token-scout cron computed when it scanned a newly listed Base token (every 4 hours, up to 20 new tokens per run, each token at most once per 7 days), recorded at scan time and shown unchanged. sell_side_flags = GoPlus reported a honeypot, can't-sell-all or a sell tax of 30% or more (the rug score is not run then); scored = the rug score ran, with its level, 0-100 score and signals; not_scored = neither produced a result. sources lists what answered, sourcesMissing what was asked and did not; degraded = the scan could not check everything, so no 'low' is certified. A row is our scan at that time, not a verdict that a token is a scam — token state changes, so re-run the check (recheck) before acting. An EAS attestation link appears only when one was actually published.",
};

export async function GET() {
  const [spreads, alerts, scans] = await Promise.all([
    radarSpreads().catch(() => null),
    readAlertFirings(20).catch(() => []),
    readScans(RADAR_SCANS).catch(() => []),
  ]);
  return NextResponse.json(
    { spreads, alerts, scans: scans.map(publicScan), method: RADAR_METHOD },
    { headers: { "Cache-Control": `public, s-maxage=${RADAR_CACHE_SEC}, stale-while-revalidate=${RADAR_CACHE_SEC}` } },
  );
}
