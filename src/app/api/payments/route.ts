/** Recent settlements recorded by the server buyer — OWNER ONLY (STATS_TOKEN gated). */

import { NextRequest, NextResponse } from "next/server";
import { listPayments } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { safeEqual } from "@/lib/secure";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const provided = req.headers.get("x-stats-token") || "";
  if (!cfg.statsToken) {
    return NextResponse.json({ error: "Locked. Set STATS_TOKEN to enable." }, { status: 503 });
  }
  if (!safeEqual(provided, cfg.statsToken)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const payments = await listPayments(50);
  return NextResponse.json({ payments });
}
