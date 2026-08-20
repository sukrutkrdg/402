/**
 * AI Health Check — is the Anthropic account alive (credits, key, API)?
 *
 * We learned the hard way that an exhausted Anthropic balance silently 400s
 * every AI service (the flagship earners) until a paying caller trips over it.
 * This endpoint makes one tiny Haiku call (~$0.00002) and returns 200 only when
 * it succeeds.
 *
 * It used to say that in a response body and stop there, on the theory that an
 * external cron's failure email would be the alert. Nothing was ever pointed at
 * it, so on 2026-08-20 the balance ran dry and the outage was found hours later
 * by a call that failed. A detector nobody reads is not a detector, so it now
 * raises the incident itself — once, and again when it clears.
 *
 * The daily spend cron runs the same probe (src/lib/ai-probe.ts) before paying
 * to re-seed anything, because an AI endpoint with no credits behind it cannot
 * settle and the money spent trying is simply gone.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 */

import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/secure";
import { probeAi } from "@/lib/ai-probe";
import { alertOwner, clearAlert } from "@/lib/alert-owner";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const probe = await probeAi();

  if (probe.ok) {
    // Only says anything if an incident was open, so a healthy day is silent.
    const cleared = await clearAlert("ai-credits", "Anthropic is answering again — the AI endpoints are back.");
    return NextResponse.json({ ok: true, ...(cleared.fired ? { recovered: true } : {}), checkedAt: new Date().toISOString() });
  }

  const alert = await alertOwner(
    "ai-credits",
    `${probe.reason}\n\nAll 10 AI endpoints are returning 400 until this is fixed. Buyers are NOT charged for them (the handler throws before settlement), but they cannot be sold and they will fall out of the discovery index if they miss their keepalive.`,
  );
  return NextResponse.json(
    { ...probe, alert, checkedAt: new Date().toISOString() },
    { status: 503 },
  );
}
