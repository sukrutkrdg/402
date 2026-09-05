/**
 * Is anyone still able to find us? — daily, and it says so when the answer is no.
 *
 * `/api/index-health` has been able to answer this for weeks. Nothing read it.
 * That is the same shape as the Anthropic outage of 2026-08-20: the detector
 * existed, it was correct, and it was never put on a schedule, so a real fault
 * sat in production until a call happened to fail. On 2026-09-04 `web-extract`
 * was found absent from discovery only because someone ran the check by hand.
 *
 * So this runs it and raises an incident when the answer needs a person. The
 * incident lands in KV and renders at the top of the stats panel, which is the
 * surface the operator actually reads — delivery beyond that is off by design
 * (see alert-owner.ts).
 *
 * WHY A CRON AND NOT A CLOUD ROUTINE
 * ----------------------------------
 * A scheduled cloud agent was tried first, on 2026-09-04, and cannot do this at
 * all: the sandbox's egress proxy refuses outbound connections to both
 * `api.cdp.coinbase.com` and `402.com.tr` — `connect_rejected` for curl,
 * `EGRESS_BLOCKED` for WebFetch. The allowlist is Anthropic's own APIs and
 * package registries. Our own cron has no such restriction and already holds the
 * credentials, so the check belongs here.
 *
 * Runs at 04:00 UTC, one hour after cron/index-all re-settles — late enough that
 * anything the keepalive fixed overnight is already fixed, so the alert is about
 * what is actually still wrong.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig, getSiteUrl } from "@/lib/config";
import { safeEqual } from "@/lib/secure";
import { checkIndexHealth, indexHealthProblems, indexHealthRepair } from "@/lib/index-health";
import { alertOwner, clearAlert } from "@/lib/alert-owner";

export const dynamic = "force-dynamic";
// One query per service at BATCH 8 — the same budget the owner-only route uses.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cfg = getConfig();
  if (!cfg.payTo) return NextResponse.json({ error: "PAY_TO_ADDRESS is not set" }, { status: 503 });

  const health = await checkIndexHealth(cfg.payTo, getSiteUrl());

  // Queries that failed tell us nothing. Raising an incident from a partial read
  // would report our own network blip as a delisting — the exact mistake the
  // measurement itself refuses to make.
  if (health.degraded) {
    return NextResponse.json({
      ok: false,
      skipped: "degraded",
      reason: `${health.uncheckedCount} service(s) could not be queried; no conclusion drawn.`,
      checkedAt: health.checkedAt,
    });
  }

  const problems = indexHealthProblems(health);

  if (problems.length === 0) {
    const cleared = await clearAlert("index-gap", "Discovery index is consistent with the catalogue again.");
    return NextResponse.json({
      ok: true,
      ...(cleared.fired ? { recovered: true } : {}),
      catalog: health.catalog,
      indexedSeen: health.indexedSeen,
      // Reported, never alerted on: this drains itself one settlement at a time.
      staleNetworksCount: health.staleNetworksCount,
      checkedAt: health.checkedAt,
    });
  }

  // Price the problems above, not the whole backlog. See indexHealthRepair.
  const repair = indexHealthRepair(health);
  const alert = await alertOwner(
    "index-gap",
    `${problems.join("\n\n")}\n\nOne paid call per affected service repairs all of it — ${repair.count} service(s), about $${repair.costUsd}. cron/index-all does this on its own schedule, oldest-settled first, so anything close to eviction is what the next run buys; trigger it sooner if this is costing sales.`,
  );

  return NextResponse.json(
    {
      ok: false,
      problems,
      missingCount: health.missingCount,
      underQuotedCount: health.underQuotedCount,
      expiringSoonCount: health.expiringSoonCount,
      wrongPayToCount: health.wrongPayTo.length,
      // What the problems above cost to fix…
      repairCount: repair.count,
      repairCostUsd: repair.costUsd,
      // …versus bringing the entire index up to date, which includes the stale
      // network rows this deliberately does not alert on.
      reseedCount: health.reseedCount,
      reseedCostUsd: health.reseedCostUsd,
      alert,
      checkedAt: health.checkedAt,
    },
    { status: 503 },
  );
}
