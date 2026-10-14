/**
 * Webhook delivery shared by the price-alert and rug-monitor crons.
 *
 * Two things the original best-effort POSTs did not give a subscriber:
 *
 * 1. Proof of origin. Each delivery carries
 *      x-402-timestamp: <unix seconds>
 *      x-402-signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${body}`)>
 *    using the per-subscription secret returned once at registration, so a
 *    receiver can reject anything that did not come from us (and replays, by
 *    checking the timestamp).
 *
 * 2. A second chance. A failed delivery used to be marked fired and dropped —
 *    a receiver that was down for one cron tick lost the alert it paid for.
 *    Callers now keep the subscription and retry up to MAX_DELIVERY_ATTEMPTS.
 */

import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { assertSafeWebhook } from "./alerts";

export const MAX_DELIVERY_ATTEMPTS = 3;

/** Per-subscription signing secret, returned to the subscriber once. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function deliverWebhook(url: string, payload: unknown, secret?: string): Promise<DeliveryResult> {
  try {
    // Re-validate right before delivery (DNS-rebinding / TOCTOU defense).
    await assertSafeWebhook(url);
  } catch (err) {
    return { ok: false, error: `blocked: ${err instanceof Error ? err.message : String(err)}` };
  }
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "402.com.tr-webhooks/1" };
  if (secret) {
    const ts = Math.floor(Date.now() / 1000);
    headers["x-402-timestamp"] = String(ts);
    headers["x-402-signature"] = signWebhook(secret, ts, body);
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(8000),
      // Never follow redirects — a 3xx to an internal host would bypass the
      // SSRF allowlist that only validated the original URL.
      redirect: "manual",
    });
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
