/**
 * Stripe — card checkout for prepaid credits.
 *
 * WHY THIS EXISTS: every paid path we ship today assumes the caller holds a
 * funded wallet. The agents that actually run in the world — ChatGPT/Gemini
 * apps, enterprise copilots, MCP clients on someone's laptop — do not. They pay
 * over card rails, or they don't pay at all. Prepaid credits already remove the
 * per-call signature; this removes the wallet from the purchase too. A human
 * buys a pack with a card, hands the `ck_…` token to their agent, and the agent
 * uses all 100+ services with no chain, no key, no signature.
 *
 * NO SDK ON PURPOSE: this talks to Stripe's REST API with `fetch` and verifies
 * webhooks with node crypto. The `stripe` package pulls a large dependency tree
 * into a bundle that already carries the payment path, and we use exactly three
 * endpoints. Fewer moving parts in the code that mints balances.
 */

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://api.stripe.com/v1";

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string | undefined;
}

/** Stripe config, or null when the card path isn't provisioned (fail closed). */
export function stripeConfig(): StripeConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;
  return { secretKey, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined };
}

/** True when the key is a live-mode key (`sk_live_…`) rather than a test key. */
export function isLiveMode(cfg: StripeConfig): boolean {
  return cfg.secretKey.startsWith("sk_live_");
}

async function stripePost<T>(cfg: StripeConfig, path: string, form: Record<string, string>): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
  const j = (await r.json()) as { error?: { message?: string } };
  if (!r.ok) throw new Error(`Stripe ${path} failed: ${j?.error?.message ?? r.status}`);
  return j as T;
}

async function stripeGet<T>(cfg: StripeConfig, path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${cfg.secretKey}` } });
  const j = (await r.json()) as { error?: { message?: string } };
  if (!r.ok) throw new Error(`Stripe ${path} failed: ${j?.error?.message ?? r.status}`);
  return j as T;
}

export interface CheckoutSession {
  id: string;
  url?: string | null;
  payment_status?: string;
  status?: string;
  amount_total?: number;
  currency?: string;
  metadata?: Record<string, string>;
}

/**
 * Create a hosted Checkout Session for one credit pack.
 *
 * Price is passed inline (`price_data`) rather than referencing a Stripe Price
 * object so the tier table in credits.ts stays the single source of truth — no
 * second place to keep in sync, and no dashboard step when a tier changes.
 */
export async function createCreditCheckout(
  cfg: StripeConfig,
  opts: { tier: string; usd: number; credits: number; successUrl: string; cancelUrl: string },
): Promise<CheckoutSession> {
  return stripePost<CheckoutSession>(cfg, "/checkout/sessions", {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(Math.round(opts.usd * 100)),
    "line_items[0][price_data][product_data][name]": `x402 Bazaar — $${(opts.credits / 100).toFixed(2)} API credit`,
    "line_items[0][price_data][product_data][description]":
      "Prepaid balance for 100+ pay-per-call APIs on Base. Spend it with the x-credit-token header — no wallet, no API key, no subscription.",
    // The tier is echoed back on the webhook so minting never trusts the client.
    "metadata[tier]": opts.tier,
    "metadata[credits]": String(opts.credits),
    "metadata[product]": "x402-bazaar-credits",
    success_url: `${opts.successUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: opts.cancelUrl,
  });
}

export async function retrieveSession(cfg: StripeConfig, id: string): Promise<CheckoutSession> {
  return stripeGet<CheckoutSession>(cfg, `/checkout/sessions/${encodeURIComponent(id)}`);
}

/**
 * Verify a Stripe webhook signature (scheme `v1`, HMAC-SHA256 over
 * `${timestamp}.${rawBody}`), including the timestamp tolerance that stops a
 * captured delivery from being replayed later.
 *
 * Returns the parsed event only when the signature checks out — an unverified
 * body must never reach the minting path, since anyone who could forge one
 * could mint themselves unlimited credit.
 */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
  toleranceSeconds = 300,
): { ok: true; event: StripeEvent } | { ok: false; reason: string } {
  if (!signatureHeader) return { ok: false, reason: "missing signature header" };

  let timestamp = "";
  const provided: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k?.trim() === "t") timestamp = (v ?? "").trim();
    if (k?.trim() === "v1") provided.push((v ?? "").trim());
  }
  if (!timestamp || provided.length === 0) return { ok: false, reason: "malformed signature header" };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return { ok: false, reason: "timestamp outside tolerance" };

  const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expBuf = Buffer.from(expected, "utf8");
  const match = provided.some((sig) => {
    const got = Buffer.from(sig, "utf8");
    return got.length === expBuf.length && timingSafeEqual(got, expBuf);
  });
  if (!match) return { ok: false, reason: "signature mismatch" };

  try {
    return { ok: true, event: JSON.parse(rawBody) as StripeEvent };
  } catch {
    return { ok: false, reason: "body is not JSON" };
  }
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: CheckoutSession & Record<string, unknown> };
}
