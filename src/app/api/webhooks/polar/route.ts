/**
 * Polar webhook — records completed card purchases.
 *
 * Minting deliberately does NOT happen here; /api/credits/claim mints after
 * asking Polar whether the checkout succeeded. Keeping the two apart means a
 * webhook outage can't stop a buyer from getting credit, and a webhook replay
 * can't mint a second balance.
 *
 * What this endpoint is for: an owner-side record of every card sale that
 * doesn't depend on the buyer's browser, so revenue is visible and support can
 * find a purchase by checkout id when someone loses their one-time token.
 *
 * Auth: Standard Webhooks signature (`webhook-id` / `webhook-timestamp` /
 * `webhook-signature`) with a timestamp tolerance. An unsigned or stale body is
 * dropped before it touches KV.
 */

import { NextRequest, NextResponse } from "next/server";
import { polarConfig, verifyWebhook } from "@/lib/polar";
import { kvLPush, kvSetNx } from "@/lib/kv";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const cfg = polarConfig();
  if (!cfg?.webhookSecret) {
    // No secret configured → we cannot authenticate deliveries, so we accept
    // nothing. 503 (not 200) so Polar surfaces the misconfiguration instead of
    // silently marking deliveries successful.
    return NextResponse.json({ error: "Polar webhook not configured." }, { status: 503 });
  }

  const raw = await req.text();
  const result = verifyWebhook(
    raw,
    {
      id: req.headers.get("webhook-id"),
      timestamp: req.headers.get("webhook-timestamp"),
      signature: req.headers.get("webhook-signature"),
    },
    cfg.webhookSecret,
  );
  if (!result.ok) return NextResponse.json({ error: `Invalid signature: ${result.reason}` }, { status: 401 });

  const event = result.event;
  const deliveryId = req.headers.get("webhook-id") ?? "";

  // Replay guard on the delivery id. Polar retries by design, and this keeps one
  // payment from appearing several times in the revenue log.
  if (!(await kvSetNx(`card:evt:${deliveryId}`, 60 * 60 * 24 * 7))) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  if (event.type === "checkout.updated" && event.data?.status === "succeeded") {
    const c = event.data;
    await kvLPush(
      "card:sales",
      JSON.stringify({
        id: c.id,
        cents: c.net_amount ?? c.amount ?? 0,
        gross: c.total_amount ?? null,
        currency: c.currency ?? "usd",
        at: new Date().toISOString(),
      }),
      500,
    );
  }

  return NextResponse.json({ received: true });
}
