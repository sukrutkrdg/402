/**
 * Card checkout for prepaid credits — the wallet-free way in.
 *
 * POST { tier } → a Stripe Checkout URL. The buyer (or the human behind an
 * agent) pays by card; the credit token is handed over afterwards by
 * /api/credits/claim. Nothing is minted here — this only opens a payment page.
 *
 * Agents are expected to call this and pass the URL to their operator: an agent
 * with no wallet still can't hold a card, but its human can click once and then
 * hand back a `ck_…` token that unlocks every paid service.
 */

import { NextRequest, NextResponse } from "next/server";
import { CREDIT_TIERS, DEFAULT_TIER } from "@/lib/credits";
import { createCreditCheckout, stripeConfig } from "@/lib/stripe";
import { getSiteUrl } from "@/lib/config";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";
import { kvConfigured } from "@/lib/kv";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const cfg = stripeConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: "Card checkout is not enabled on this deployment. Pay with USDC over x402 instead: /api/x402/buy-credits" },
      { status: 503 },
    );
  }
  // Credits live in KV. Without it the claim step could never mint, so refuse to
  // take the customer's money in the first place.
  if (!kvConfigured()) {
    return NextResponse.json({ error: "Credits are temporarily unavailable (no durable store)." }, { status: 503 });
  }

  // Creating sessions is free but not free of abuse — cap per IP.
  const rl = await rateLimitKv(`stripe:checkout:${clientIp(req)}`, 10, 300);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit: try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` },
      { status: 429 },
    );
  }

  let tier = DEFAULT_TIER;
  try {
    const body = (await req.json()) as { tier?: string };
    if (body?.tier) tier = String(body.tier).trim();
  } catch {
    // No body → default tier.
  }
  const pack = CREDIT_TIERS[tier];
  if (!pack) {
    return NextResponse.json(
      { error: `Unknown tier. Choose one of: ${Object.keys(CREDIT_TIERS).join(", ")}` },
      { status: 400 },
    );
  }

  const site = getSiteUrl();
  try {
    const session = await createCreditCheckout(cfg, {
      tier,
      usd: pack.usd,
      credits: pack.credits,
      successUrl: `${site}/credits`,
      cancelUrl: `${site}/credits?canceled=1`,
    });
    if (!session.url) throw new Error("Stripe returned no checkout URL");
    return NextResponse.json({
      checkoutUrl: session.url,
      sessionId: session.id,
      tier,
      paidUsd: pack.usd,
      creditedUsd: +(pack.credits / 100).toFixed(2),
      next: "Open checkoutUrl, pay, and you'll be returned to /credits where the credit token is shown once.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not create checkout session" },
      { status: 502 },
    );
  }
}
