/**
 * Polar — card checkout for prepaid credits.
 *
 * WHY POLAR AND NOT STRIPE: Stripe has no Türkiye entity, so this seller cannot
 * be a Stripe merchant at all. Polar is a Merchant of Record — it is the legal
 * seller, handles VAT in every jurisdiction, and pays out to Türkiye over Stripe
 * Connect Express. Same shape as any hosted checkout, so the flow below is the
 * one the routes already expect: create → redirect → verify paid → mint.
 *
 * NO SDK ON PURPOSE: three REST calls and one HMAC. The code that mints spendable
 * balances is not where a large dependency tree belongs.
 */

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface PolarConfig {
  accessToken: string;
  productId: string;
  webhookSecret: string | undefined;
  apiBase: string;
  sandbox: boolean;
}

/** Polar config, or null when the card path isn't provisioned (fail closed). */
export function polarConfig(): PolarConfig | null {
  const accessToken = process.env.POLAR_ACCESS_TOKEN?.trim();
  const productId = process.env.POLAR_PRODUCT_ID?.trim();
  if (!accessToken || !productId) return null;
  // Sandbox is a separate host with its own tokens/products — never mix them up
  // silently, or "test" purchases would mint real balances (or vice versa).
  const sandbox = process.env.POLAR_SERVER?.trim().toLowerCase() === "sandbox";
  return {
    accessToken,
    productId,
    webhookSecret: process.env.POLAR_WEBHOOK_SECRET?.trim() || undefined,
    apiBase: sandbox ? "https://sandbox-api.polar.sh" : "https://api.polar.sh",
    sandbox,
  };
}

async function call<T>(cfg: PolarConfig, path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${cfg.apiBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${cfg.accessToken}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await r.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!r.ok) {
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? JSON.stringify((body as { detail: unknown }).detail)
        : String(text).slice(0, 200);
    throw new Error(`Polar ${path} failed (${r.status}): ${detail}`);
  }
  return body as T;
}

/** Subset of Polar's Checkout object that this integration relies on. */
export interface PolarCheckout {
  id: string;
  url?: string;
  status: "open" | "expired" | "confirmed" | "succeeded" | "failed";
  /** Cents, after discounts, before tax — what we're actually paid for. */
  net_amount?: number;
  amount?: number;
  total_amount?: number;
  currency?: string;
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Open a hosted checkout for `usd`.
 *
 * The amount is passed per session against a single pay-what-you-want product,
 * so the pack table stays in credits.ts instead of being duplicated as separate
 * products in the Polar dashboard.
 */
export async function createCreditCheckout(
  cfg: PolarConfig,
  opts: { usd: number; successUrl: string },
): Promise<PolarCheckout> {
  return call<PolarCheckout>(cfg, "/v1/checkouts/", {
    method: "POST",
    body: JSON.stringify({
      products: [cfg.productId],
      amount: Math.round(opts.usd * 100),
      currency: "usd",
      // Polar substitutes the real id here on redirect.
      success_url: `${opts.successUrl}?checkout_id={CHECKOUT_ID}`,
      metadata: { product: "x402-bazaar-credits" },
    }),
  });
}

export async function retrieveCheckout(cfg: PolarConfig, id: string): Promise<PolarCheckout> {
  return call<PolarCheckout>(cfg, `/v1/checkouts/${encodeURIComponent(id)}`);
}

/**
 * Verify a Polar webhook (Standard Webhooks: `webhook-id`, `webhook-timestamp`,
 * `webhook-signature`, signature = base64 HMAC-SHA256 over `id.timestamp.body`).
 *
 * Polar's dashboard secret is a raw string rather than the base64 blob the spec
 * assumes, and their own docs tell you to base64-encode it before handing it to
 * a standard verifier — which then decodes it back. Different clients therefore
 * disagree about which bytes are the key, so both derivations are accepted.
 * That is not a weakening: forging a signature still requires the secret; it
 * only stops a valid delivery from being rejected over an encoding convention.
 */
export function verifyWebhook(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  toleranceSeconds = 300,
): { ok: true; event: PolarEvent } | { ok: false; reason: string } {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing webhook-* headers" };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return { ok: false, reason: "timestamp outside tolerance" };

  const bare = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keys = [Buffer.from(bare, "utf8"), Buffer.from(bare, "base64")].filter((k) => k.length > 0);
  const signed = `${id}.${timestamp}.${rawBody}`;
  const expected = keys.map((k) => createHmac("sha256", k).update(signed).digest("base64"));

  // Header is a space-separated list of `v1,<base64>` entries (supports rotation).
  const provided = signature
    .split(" ")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith("v1,") ? p.slice(3) : p));

  const match = provided.some((got) =>
    expected.some((exp) => {
      const a = Buffer.from(got, "utf8");
      const b = Buffer.from(exp, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    }),
  );
  if (!match) return { ok: false, reason: "signature mismatch" };

  try {
    return { ok: true, event: JSON.parse(rawBody) as PolarEvent };
  } catch {
    return { ok: false, reason: "body is not JSON" };
  }
}

export interface PolarEvent {
  type: string;
  data: PolarCheckout & Record<string, unknown>;
}
