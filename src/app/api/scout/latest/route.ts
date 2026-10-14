/**
 * GET /api/scout/latest — free JSON read of the latest token-scout scans, as
 * recorded by the cron at scan time (src/lib/live-events.ts, `scout:results`).
 *
 * ?limit=1..50 (default 20). Rate-limited per IP (30/min) and CDN-cached 60s;
 * the cron writes every 4 hours, so polling faster than a minute gains nothing.
 *
 * Each row is "our scan at <at> computed <verdict/level/flags>", not a verdict
 * that a token is a scam; `recheck` re-runs the rug score now.
 */

import { NextRequest, NextResponse } from "next/server";
import { publicScan, readScans } from "@/lib/live-events";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const CACHE_SEC = 60;
const MAX_LIMIT = 50;

export async function GET(req: NextRequest) {
  const rl = rateLimit(`scout-latest:${clientIp(req)}`, 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limited — this list changes every 4 hours; poll at most once a minute." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }
  const raw = Number(req.nextUrl.searchParams.get("limit") ?? 20);
  const limit = Number.isFinite(raw) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw))) : 20;
  const scans = await readScans(limit).catch(() => []);
  return NextResponse.json(
    {
      scans: scans.map(publicScan),
      count: scans.length,
      method:
        "Recorded by our token-scout cron (every 4h, up to 20 newly listed Base tokens per run) exactly as computed: sell_side_flags = GoPlus honeypot / can't-sell-all / sell tax >= 30%; scored = rug score level, score and signals; not_scored = no result. sources answered, sourcesMissing did not; degraded = incomplete check. A point-in-time scan, not a verdict — use recheck before acting.",
    },
    { headers: { "Cache-Control": `public, s-maxage=${CACHE_SEC}, stale-while-revalidate=${CACHE_SEC}` } },
  );
}
