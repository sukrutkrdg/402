/**
 * Card checkout for prepaid credits — the wallet-free way in.
 *
 * POST { pack } → a hosted Polar checkout URL. The buyer (or the human behind an
 * agent) pays by card; the credit token is handed over afterwards by
 * /api/credits/claim. Nothing is minted here — this only opens a payment page.
 *
 * Agents are expected to call this and pass the URL to their operator: an agent
 * with no wallet still can't hold a card, but its human can click once and then
 * hand back a `ck_…` token that unlocks every paid service.
 */

import { NextRequest, NextResponse } from "next/server";
import { CARD_PACKS } from "@/lib/credits";
import { createCreditCheckout, polarConfig } from "@/lib/polar";
import { getSiteUrl } from "@/lib/config";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";
import { kvConfigured } from "@/lib/kv";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const cfg = polarConfig();
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
  const rl = await rateLimitKv(`card:checkout:${clientIp(req)}`, 10, 300);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit: try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` },
      { status: 429 },
    );
  }

  let key = "5";
  try {
    const body = (await req.json()) as { pack?: string; tier?: string };
    if (body?.pack || body?.tier) key = String(body.pack ?? body.tier).trim();
  } catch {
    // No body → default pack.
  }
  const pack = CARD_PACKS[key];
  if (!pack) {
    return NextResponse.json(
      {
        error: `Unknown pack. Card packs: ${Object.keys(CARD_PACKS).join(", ")}. Smaller amounts are available with USDC over x402 (/api/x402/buy-credits) — card fees make them uneconomic.`,
      },
      { status: 400 },
    );
  }

  try {
    const checkout = await createCreditCheckout(cfg, { usd: pack.usd, successUrl: `${getSiteUrl()}/credits` });
    if (!checkout.url) throw new Error("Polar returned no checkout URL");
    return NextResponse.json({
      checkoutUrl: checkout.url,
      checkoutId: checkout.id,
      pack: key,
      paidUsd: pack.usd,
      creditedUsd: +(pack.credits / 100).toFixed(2),
      sandbox: cfg.sandbox || undefined,
      next: "Open checkoutUrl, pay, and you'll be returned to /credits where the credit token is shown once.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not create checkout session" },
      { status: 502 },
    );
  }
}
