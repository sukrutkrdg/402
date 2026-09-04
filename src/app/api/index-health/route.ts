/**
 * Index health — OWNER ONLY (STATS_TOKEN gated).
 *
 * A thin door in front of `checkIndexHealth`. The measurement itself lives in
 * src/lib/index-health.ts, because cron/index-gap raises an incident from the
 * same numbers and two implementations of "is anyone able to find us" would
 * eventually disagree about it.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig, getSiteUrl } from "@/lib/config";
import { safeEqual } from "@/lib/secure";
import { checkIndexHealth } from "@/lib/index-health";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  return NextResponse.json(await checkIndexHealth(cfg.payTo, getSiteUrl()));
}
