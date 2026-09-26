/**
 * Buy a prepaid credit pack with NEAR Intents (1Click) — for agents with value
 * on NEAR (or any chain 1Click routes) and no USDC on Base.
 *
 * GET  → how this rail works, the tiers, and what to send.
 * POST → { tier, originAsset, refundTo, depositType? } creates an order and
 *        returns the deposit address to pay. See src/lib/near-intents.ts.
 *
 * Off unless ENABLE_NEAR_CREDITS=true. The x402 challenge on every paid route
 * is untouched by this; it is a separate way to buy the same credits.
 */

import { NextRequest, NextResponse } from "next/server";
import { CREDIT_TIERS } from "@/lib/credits";
import { createNearOrder, nearCreditsEnabled, NearOrderError } from "@/lib/near-intents";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";
import { getSiteUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

const disabled = () =>
  NextResponse.json({ error: "Paying with NEAR Intents is not enabled on this deployment." }, { status: 404 });

export function GET() {
  if (!nearCreditsEnabled()) return disabled();
  const site = getSiteUrl();
  return NextResponse.json({
    rail: "NEAR Intents (1Click) → prepaid credits",
    what: "Pay for a credit pack with any asset 1Click routes (NEAR, USDC on NEAR, BTC, SOL, …). It is swapped to USDC on Base for us; you receive an x-credit-token that works on every paid endpoint.",
    tiers: Object.fromEntries(
      Object.entries(CREDIT_TIERS).map(([t, p]) => [t, { payUsd: p.usd, creditsUsd: +(p.credits / 100).toFixed(2) }]),
    ),
    create: {
      method: "POST",
      url: `${site}/api/credits/near/quote`,
      body: {
        tier: "one of the tiers above, e.g. \"5\"",
        originAsset: "1Click asset id you pay with, e.g. \"nep141:wrap.near\" (NEAR) — full list: https://1click.chaindefuser.com/v0/tokens",
        cheapest: "USDC on NEAR (\"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\") — stablecoin to stablecoin, no price exposure during the swap",
        refundTo: "your address/account on the origin chain, where 1Click refunds a swap that does not complete",
        depositType: "optional: ORIGIN_CHAIN (default, send on-chain) or INTENTS (you already hold a balance inside NEAR Intents)",
      },
    },
    status: `${site}/api/credits/near/status?orderId=<orderId> with header x-order-secret: <orderSecret>`,
    fees: "Swap cost is on the payer: we quote EXACT_OUTPUT, so the pack price arrives in full and any unused input is refunded by 1Click.",
  });
}

export async function POST(req: NextRequest) {
  if (!nearCreditsEnabled()) return disabled();

  const rl = await rateLimitKv(`nearquote:${clientIp(req)}`, 10, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Send a JSON body: { tier, originAsset, refundTo }" }, { status: 400 });
  }

  try {
    const order = await createNearOrder({
      tier: String(body.tier ?? ""),
      originAsset: String(body.originAsset ?? ""),
      refundTo: String(body.refundTo ?? ""),
      depositType: body.depositType ? String(body.depositType) : undefined,
    });
    return NextResponse.json(order, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const status = err instanceof NearOrderError ? err.status : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
