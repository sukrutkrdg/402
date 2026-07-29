/**
 * Stripe webhook — records completed card purchases.
 *
 * Minting deliberately does NOT happen here; /api/credits/claim mints after
 * asking Stripe whether the session is paid. Keeping the two apart means a
 * webhook outage can't stop a buyer from getting credit, and a webhook replay
 * can't mint a second balance.
 *
 * What this endpoint is for: an owner-side record of every card sale that
 * doesn't depend on the buyer's browser, so revenue is visible and support can
 * find a purchase by session id when someone loses their one-time token.
 *
 * Auth: Stripe's `stripe-signature` header (HMAC-SHA256 with timestamp
 * tolerance). An unsigned or stale body is dropped before it touches KV.
 */

import { NextRequest, NextResponse } from "next/server";
import { stripeConfig, verifyWebhook } from "@/lib/stripe";
import { kvLPush, kvSetNx } from "@/lib/kv";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const cfg = stripeConfig();
  if (!cfg?.webhookSecret) {
    // No secret configured → we cannot authenticate deliveries, so we accept
    // nothing. 503 (not 200) so Stripe surfaces the misconfiguration instead of
    // silently marking deliveries successful.
    return NextResponse.json({ error: "Stripe webhook not configured." }, { status: 503 });
  }

  const raw = await req.text();
  const result = verifyWebhook(raw, req.headers.get("stripe-signature"), cfg.webhookSecret);
  if (!result.ok) {
    return NextResponse.json({ error: `Invalid signature: ${result.reason}` }, { status: 401 });
  }
  const event = result.event;

  // Replay guard on the event id. Stripe retries deliveries by design, and this
  // keeps one payment from appearing several times in the revenue log.
  if (!(await kvSetNx(`stripe:evt:${event.id}`, 60 * 60 * 24 * 7))) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    if (s.metadata?.product === "x402-bazaar-credits" && s.payment_status === "paid") {
      await kvLPush(
        "stripe:sales",
        JSON.stringify({
          id: s.id,
          tier: s.metadata?.tier ?? null,
          credits: Number(s.metadata?.credits ?? 0),
          amount: (s.amount_total ?? 0) / 100,
          currency: s.currency ?? "usd",
          at: new Date().toISOString(),
        }),
        500,
      );
    }
  }

  return NextResponse.json({ received: true });
}
