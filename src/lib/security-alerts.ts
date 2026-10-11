/**
 * security-alerts — Webhook Alert Push Engine for x402 Bazaar.
 *
 * Enables autonomous agents and developers to register webhooks for critical
 * onchain security and risk triggers:
 * - HONEYPOT_DETECTED (sell tax spike, honeypot lock)
 * - B20_SEIZURE_ACTIVATED (burnBlocked or policy registry freeze)
 * - WHALE_DUMP_RISK (liquidity exit concentration > 70%)
 * - CLANKER_IMPERSONATOR (fake impersonator contract detected)
 *
 * Implements strict SSRF protection, HMAC-SHA256 delivery signing, and test pinging.
 */

import "server-only";
import crypto from "node:crypto";
import { assertSafeWebhook } from "./alerts";
import { kvSet, kvGet, kvSAdd, kvSMembers, kvConfigured } from "./kv";

export type SecurityAlertType =
  | "HONEYPOT_DETECTED"
  | "B20_SEIZURE_ACTIVATED"
  | "WHALE_DUMP_RISK"
  | "CLANKER_IMPERSONATOR";

export interface SecurityWebhookSubscription {
  id: string;
  webhookUrl: string;
  secret: string; // HMAC secret
  alertType: SecurityAlertType;
  tokenAddress?: string; // Optional target token address filter
  createdAt: string;
  lastPingAt?: string;
  lastPingStatus?: number;
}

// In-memory fallback if durable KV is unconfigured (development/test mode)
const memorySubscriptions = new Map<string, SecurityWebhookSubscription>();
const memorySubIds = new Set<string>();

/**
 * Sign payload with HMAC-SHA256 secret.
 */
export function signWebhookPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Register a new security alert webhook subscription.
 */
export async function registerSecurityWebhook(opts: {
  webhookUrl: string;
  alertType: SecurityAlertType;
  tokenAddress?: string;
  secret?: string;
}): Promise<SecurityWebhookSubscription> {
  const safeUrl = await assertSafeWebhook(opts.webhookUrl);
  const validTypes: SecurityAlertType[] = [
    "HONEYPOT_DETECTED",
    "B20_SEIZURE_ACTIVATED",
    "WHALE_DUMP_RISK",
    "CLANKER_IMPERSONATOR",
  ];

  if (!validTypes.includes(opts.alertType)) {
    throw new Error(`Invalid alertType: must be one of ${validTypes.join(", ")}`);
  }

  let normalizedToken: string | undefined;
  if (opts.tokenAddress) {
    const raw = opts.tokenAddress.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      throw new Error("Invalid tokenAddress: must be a 0x… 40-hex Base contract address");
    }
    normalizedToken = raw.toLowerCase();
  }

  const id = `wh_${crypto.randomBytes(8).toString("hex")}`;
  const secret = opts.secret || crypto.randomBytes(16).toString("hex");

  const sub: SecurityWebhookSubscription = {
    id,
    webhookUrl: safeUrl.toString(),
    secret,
    alertType: opts.alertType,
    tokenAddress: normalizedToken,
    createdAt: new Date().toISOString(),
  };

  if (kvConfigured()) {
    await kvSet(`secwh:${id}`, JSON.stringify(sub), 60 * 60 * 24 * 30); // 30 days
    await kvSAdd("secwh:active", id);
  } else {
    memorySubscriptions.set(id, sub);
    memorySubIds.add(id);
  }

  return sub;
}

/**
 * Dispatch a test ping event to verify the caller's webhook endpoint.
 */
export async function sendWebhookPing(sub: SecurityWebhookSubscription): Promise<{
  delivered: boolean;
  statusCode: number;
  latencyMs: number;
  signature: string;
}> {
  // Re-verify safe webhook right before dispatch (DNS rebinding defense)
  const safeUrl = await assertSafeWebhook(sub.webhookUrl);

  const payload = JSON.stringify({
    event: "ping",
    subscriptionId: sub.id,
    alertType: sub.alertType,
    tokenAddress: sub.tokenAddress ?? "all",
    timestamp: new Date().toISOString(),
    message: "x402 Bazaar Security Alert Webhook Verification Ping",
  });

  const signature = signWebhookPayload(payload, sub.secret);
  const started = Date.now();

  try {
    const res = await fetch(safeUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "x402-Bazaar-Webhook/1.0",
        "X-Bazaar-Signature": `sha256=${signature}`,
        "X-Bazaar-Event": "ping",
      },
      body: payload,
      signal: AbortSignal.timeout(5000), // 5s timeout budget
    });

    const latencyMs = Date.now() - started;
    return {
      delivered: res.ok,
      statusCode: res.status,
      latencyMs,
      signature,
    };
  } catch {
    const latencyMs = Date.now() - started;
    return {
      delivered: false,
      statusCode: 0,
      latencyMs,
      signature,
    };
  }
}
