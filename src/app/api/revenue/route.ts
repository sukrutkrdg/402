/** Revenue (incoming USDC to the seller wallet) — OWNER ONLY (STATS_TOKEN gated). */

import { NextRequest, NextResponse } from "next/server";
import { getRevenue } from "@/lib/revenue";
import { stuckRefunds } from "@/lib/credits";
import { getConfig } from "@/lib/config";
import { safeEqual } from "@/lib/secure";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const url = new URL(req.url);
  // Header only — never accept the token in the query string (it leaks into logs).
  const provided = req.headers.get("x-stats-token") || "";

  // Private dashboard: requires STATS_TOKEN to be set and matched.
  if (!cfg.statsToken) {
    return NextResponse.json(
      { error: "Revenue dashboard is locked. Set STATS_TOKEN in the environment to enable it." },
      { status: 503 },
    );
  }
  if (!safeEqual(provided, cfg.statsToken)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const blocksParam = url.searchParams.get("blocks");
  const blocks = blocksParam ? parseInt(blocksParam, 10) : 5000;
  const safeBlocks = Number.isFinite(blocks) ? Math.min(Math.max(blocks, 1), 50000) : 5000;
  const data = await getRevenue(safeBlocks);
  // Money we took sits next to money we owe back and could not pay: a refund
  // that failed because KV was down is revenue we are not entitled to.
  const owed = await stuckRefunds();
  return NextResponse.json({ ...data, ...(owed.count > 0 ? { unpaidRefunds: owed } : {}) });
}
