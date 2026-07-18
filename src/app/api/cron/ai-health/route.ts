/**
 * AI Health Check — is the Anthropic account alive (credits, key, API)?
 *
 * We learned the hard way that an exhausted Anthropic balance silently 400s
 * every AI service (the flagship earners) until a paying caller trips over it.
 * This endpoint makes one tiny Haiku call (~$0.00002) and returns 200 only when
 * it succeeds. Point a daily cron-job.org job here with failure notifications
 * on — the job's failure email IS the billing alert.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 */

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { safeEqual } from "@/lib/secure";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    return NextResponse.json({ ok: false, reason: "ANTHROPIC_API_KEY not set" }, { status: 503 });
  }

  try {
    const msg = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    return NextResponse.json({ ok: true, model: MODEL, usage: msg.usage, checkedAt: new Date().toISOString() });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Billing exhaustion surfaces as invalid_request_error mentioning credit
    // balance — call it out explicitly so the alert email says WHY.
    const credits = /credit balance|billing|purchase credits/i.test(raw);
    return NextResponse.json(
      {
        ok: false,
        reason: credits ? "ANTHROPIC CREDITS EXHAUSTED — every AI service is down. Top up at console.anthropic.com." : "Anthropic API error",
        detail: raw.slice(0, 300),
        checkedAt: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
