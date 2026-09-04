/** Revenue (incoming USDC to the seller wallet) — OWNER ONLY (STATS_TOKEN gated). */

import { NextRequest, NextResponse } from "next/server";
import { getRevenue } from "@/lib/revenue";
import { stuckRefunds } from "@/lib/credits";
import { openIncident } from "@/lib/alert-owner";
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
  // Anything that stops us selling is a revenue event, so it belongs on the
  // revenue page — and it survives here even when the messenger is unconfigured,
  // which is the failure mode that produced this surface in the first place.
  //
  // Every kind, not just `ai-credits`. That one was hardcoded, so when
  // cron/index-gap started raising `index-gap` the incident would have been
  // written to KV and rendered nowhere — a detector nobody reads, which is the
  // exact bug this panel exists to prevent. Order is severity: an outage that
  // stops the AI endpoints outranks a discovery gap, which outranks a wallet
  // running low.
  const kinds = ["ai-credits", "index-gap", "buyer-funds", "surfaces"] as const;
  const open = (await Promise.all(kinds.map(async (kind) => ({ kind, inc: await openIncident(kind) }))))
    .filter((r): r is { kind: (typeof kinds)[number]; inc: NonNullable<Awaited<ReturnType<typeof openIncident>>> } => r.inc !== null)
    .map((r) => ({ kind: r.kind, since: r.inc.since, text: r.inc.text }));
  return NextResponse.json({
    ...data,
    ...(owed.count > 0 ? { unpaidRefunds: owed } : {}),
    // `openIncident` stays singular for the panel that already reads it; the
    // full list is beside it so a second one is not silently dropped.
    ...(open.length > 0 ? { openIncident: open[0], openIncidents: open } : {}),
  });
}
