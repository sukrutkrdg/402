/**
 * Index refresh — keeps the catalog discoverable.
 *
 * A resource enters the CDP Bazaar index only after a settled payment, and it
 * LEAVES again when it stops seeing them: four of our listings dropped out
 * inside a single day in August 2026 while we watched. Discovery is a rolling
 * window, not a registration, so a listing nobody buys becomes a listing nobody
 * can find — which is the exact loop that keeps it unbought.
 *
 * This settles one payment against the endpoints that have not seen one lately,
 * so each stays inside the window. Two things keep it from being a money pit:
 *
 *   - A real paid call marks the service fresh too (the x402 route sets the same
 *     key). So every organic purchase removes an endpoint from this run, and the
 *     bill shrinks as demand grows. That is the right direction for it to move.
 *   - Hard caps per invocation on both count and spend, so a bug here cannot
 *     drain the buyer wallet — and ENABLE_BUYER=false still disables everything.
 *
 * Inputs come from each service's own published example, the same declaration an
 * agent would follow. The parameter map this used to carry handed USDC to every
 * address-shaped field, which meant every B20 endpoint answered "not a B20
 * token" — an error settles nothing, so those calls bought exactly nothing.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}. Needs BUYER_PRIVATE_KEY funded.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPayingFetch } from "@/lib/x402-client";
import { safeEqual } from "@/lib/secure";
import { SERVICES } from "@/lib/services";
import { kvGet, kvSet } from "@/lib/kv";
import { getConfig } from "@/lib/config";
import { exampleInputFor } from "@/lib/discovery-examples";
import { priceCents } from "@/lib/price";
import { indexFreshKey, INDEX_FRESH_SECONDS, indexSeededKey, INDEX_SEEDED_SECONDS } from "@/lib/index-freshness";
import { probeAi } from "@/lib/ai-probe";
import { alertOwner, clearAlert } from "@/lib/alert-owner";
import { checkSurfaces } from "@/lib/surface-check";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ORIGIN = (process.env.NEXT_PUBLIC_SITE_URL || "https://402.com.tr").replace(/\/$/, "");

/** Settlements per invocation. Each takes a few seconds; this leaves headroom
 *  under maxDuration and spreads the spend across days rather than one burst. */
const MAX_PER_RUN = 12;
/** Hard ceiling per invocation, in cents. A cap that cannot be exceeded matters
 *  more than the exact number: this route is the only scheduled thing that spends. */
const MAX_SPEND_CENTS = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Master spend kill-switch: ENABLE_BUYER=false disables ALL buyer spending.
  if (!getConfig().enableBuyer) {
    return NextResponse.json({ skipped: "spending disabled (ENABLE_BUYER=false)", refreshed: 0 });
  }

  let pay: ReturnType<typeof getPayingFetch>;
  try {
    pay = getPayingFetch();
  } catch {
    return NextResponse.json({ skipped: "BUYER_PRIVATE_KEY not configured" });
  }

  const url = new URL(req.url);
  const only = (url.searchParams.get("only") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const dryRun = url.searchParams.get("dry") === "1";

  const pool = only.length ? SERVICES.filter((s) => only.includes(s.id)) : SERVICES.filter((s) => !s.hidden);

  // One token, before spending anything. An AI endpoint with no credits behind
  // it cannot settle, so every attempt against one is a call that costs us a
  // slot in this run's cap and buys nothing — and it is the run that would have
  // kept it in the index. This is also the only scheduled thing that runs daily,
  // which makes it the right place to notice the account has gone dry.
  const ai = await probeAi();
  let aiAlert: Awaited<ReturnType<typeof alertOwner>> | undefined;
  if (!ai.ok) {
    aiAlert = await alertOwner(
      "ai-credits",
      `${ai.reason}\n\nThe daily index refresh is skipping every AI endpoint this run, so they will fall out of the discovery index if this is not fixed before their keepalive is due.`,
    );
  } else {
    await clearAlert("ai-credits", "Anthropic is answering again — the AI endpoints are back and the index refresh will resume covering them.");
  }

  // Once a week, check that the places we are published still show us. Folded
  // in here rather than given its own schedule because this is the job that
  // already runs daily and already knows how to raise an incident — and because
  // a listing that quietly goes invisible is the same class of failure as an
  // endpoint that quietly falls out of the index, which is what this cron exists
  // to prevent.
  let surfaces: Awaited<ReturnType<typeof checkSurfaces>> | undefined;
  if (!dryRun && !(await kvGet("surfaces:checked"))) {
    await kvSet("surfaces:checked", "1", 60 * 60 * 24 * 7);
    surfaces = await checkSurfaces(getConfig().payTo);
    const broken = surfaces.filter((s) => !s.ok);
    if (broken.length) {
      await alertOwner(
        "surfaces",
        `Published surfaces that would not find us today:\n\n${broken.map((s) => `• ${s.name}: ${s.detail}`).join("\n")}`,
      );
    } else {
      await clearAlert("surfaces", "All published surfaces are showing us again.");
    }
  }

  const results: Array<{ service: string; status: number | string; cents?: number }> = [];
  let refreshed = 0;
  let attempts = 0;
  let spent = 0;
  let stale = 0;
  let aiSkipped = 0;

  // Which ones need paying for, and which of those are closest to falling out.
  //
  // This used to be one pass in catalogue order, and with a backlog larger than
  // a run's budget that is the same as choosing at random: on 2026-09-05 ten
  // services sat inside their last ten days while the conveyor spent the day's
  // twelve slots on endpoints with three weeks of margin. The budget is not the
  // problem — the order it is spent in was. So the stale set is collected first
  // and sorted by when it last settled, oldest first, and a service with no
  // timestamp at all (never settled, or so long ago the record expired) sorts
  // ahead of every dated one.
  const staleSet: Array<{ s: (typeof pool)[number]; seededAt: number }> = [];
  for (const s of pool) {
    // Fresh already — either this cron settled it recently, or, better, a real
    // customer did.
    if (!only.length && (await kvGet(indexFreshKey(s.id)))) {
      results.push({ service: s.id, status: "fresh" });
      continue;
    }
    const seen = await kvGet(indexSeededKey(s.id));
    const seededAt = Number(seen);
    staleSet.push({ s, seededAt: Number.isFinite(seededAt) && seen ? seededAt : 0 });
  }
  staleSet.sort((a, b) => a.seededAt - b.seededAt);

  for (const { s } of staleSet) {
    stale++;
    // Not counted as an attempt: it never reached the wire, and it should be
    // first in line the moment the account is topped up.
    if (!ai.ok && s.category === "AI") {
      aiSkipped++;
      results.push({ service: s.id, status: "skipped-ai-unavailable" });
      continue;
    }
    const cents = priceCents(s.price);
    // The cap bounds a run; it must not make an endpoint unbuyable. Our two
    // $0.75 reports cost more than the whole per-run budget, so `spent + cents >
    // cap` was true for them at spent = 0 — they were deferred every single run,
    // forever, and would have evicted from the index with keepalive never once
    // having tried. Letting the FIRST purchase of a run exceed the cap fixes
    // that and still bounds the worst case at cap + one price.
    const overCap = spent + cents > MAX_SPEND_CENTS && spent > 0;
    if (attempts >= MAX_PER_RUN || overCap) {
      results.push({ service: s.id, status: "deferred-next-run" });
      continue;
    }
    // buy-credits mints spendable balance; refreshing it would be buying our own
    // credit with our own money for nothing.
    if (s.id === "buy-credits") {
      results.push({ service: s.id, status: "skipped-mints-credit" });
      continue;
    }

    const params = exampleInputFor(s) ?? {};
    const missingRequired = s.params.filter((p) => p.required && !params[p.name]).map((p) => p.name);
    if (missingRequired.length) {
      // The declaration cannot produce a runnable call, so neither can an agent.
      // Worth surfacing rather than silently skipping.
      results.push({ service: s.id, status: `no-example:${missingRequired.join(",")}` });
      continue;
    }

    if (dryRun) {
      results.push({ service: s.id, status: "would-pay", cents });
      attempts++;
      spent += cents;
      continue;
    }

    const qs = new URLSearchParams(params).toString();
    attempts++;
    try {
      const res = await pay(`${ORIGIN}/api/x402/${s.id}${qs ? `?${qs}` : ""}`);
      results.push({ service: s.id, status: res.status, cents });
      if (res.ok) {
        refreshed++;
        spent += cents;
        await kvSet(indexFreshKey(s.id), "1", INDEX_FRESH_SECONDS);
        // Dated, so the next run with a backlog knows this one is now the least
        // urgent rather than merely "not fresh".
        await kvSet(indexSeededKey(s.id), String(Date.now()), INDEX_SEEDED_SECONDS);
      }
    } catch (e) {
      results.push({ service: s.id, status: e instanceof Error ? e.message.slice(0, 60) : "error" });
    }
  }

  return NextResponse.json({
    refreshed,
    staleFound: stale,
    spentCents: spent,
    capCents: MAX_SPEND_CENTS,
    total: pool.length,
    dryRun,
    ...(surfaces ? { surfaces } : {}),
    ai: ai.ok ? { ok: true } : { ok: false, reason: ai.reason, creditsExhausted: ai.creditsExhausted, skipped: aiSkipped, alert: aiAlert },
    note:
      "Each settled call keeps a listing inside the discovery window for 21 days. Real customer payments mark a service fresh too, so this bill falls as demand rises." +
      (ai.ok ? "" : ` ${aiSkipped} AI endpoint(s) were skipped this run because the Anthropic account cannot answer — paying for them would settle nothing.`),
    results,
  });
}
