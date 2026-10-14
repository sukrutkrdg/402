/**
 * GET /api/cron/check-alerts
 *
 * Polls all active price alerts and fires webhooks when thresholds are crossed.
 *
 * Security: protected by a shared secret.  Vercel Cron automatically sends
 *   Authorization: Bearer <CRON_SECRET>
 * when CRON_SECRET is set in your environment variables.  External cron
 * services (e.g. cron-job.org) must include the same header manually.
 *
 * Returns: { checked, fired, errors } — safe to log / monitor.
 *
 * NOTE (Hobby plan): vercel.json schedules this at "0 * * * *" (hourly).
 * Vercel Hobby only supports daily crons, so set the schedule to "0 0 * * *"
 * there and point an external cron at this endpoint every few minutes for
 * near-real-time alerting.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  listActiveAlerts,
  getAlert,
  markFired,
  fetchTokenPrice,
  saveAlert,
  type Alert,
} from "@/lib/alerts";
import { deliverWebhook, MAX_DELIVERY_ATTEMPTS } from "@/lib/webhook-delivery";
import { kvConfigured } from "@/lib/kv";
import { safeEqual } from "@/lib/secure";
import { checkRugMonitors } from "@/lib/rug-monitor";

/** Deliver a fired alert's webhook; keep it active for a retry if delivery failed. */
async function deliverAlert(alert: Alert, errors: string[]): Promise<void> {
  const res = await deliverWebhook(
    alert.webhook,
    {
      type: "price_alert",
      alertId: alert.id,
      token: alert.token,
      direction: alert.direction,
      threshold: alert.threshold,
      currentPrice: alert.firedPrice,
      priceAtCreate: alert.priceAtCreate,
      createdAt: alert.createdAt,
      firedAt: alert.firedAt,
    },
    alert.secret,
  );
  alert.deliveryAttempts = (alert.deliveryAttempts ?? 0) + 1;
  alert.delivered = res.ok;
  alert.lastDeliveryError = res.ok ? undefined : res.error;
  await saveAlert(alert);
  if (res.ok || alert.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) await markFired(alert.id, alert.firedPrice);
  if (!res.ok) errors.push(`${alert.id}: webhook delivery attempt ${alert.deliveryAttempts} failed — ${res.error}`);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ---- Auth check ----
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET environment variable is not set" },
      { status: 401 },
    );
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const provided = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (!safeEqual(provided, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Without KV, alerts live in per-instance memory — a cron hitting a different
  // instance sees nothing. Surface that instead of silently reporting 0.
  const kvWarning = kvConfigured()
    ? undefined
    : "KV not configured — alerts are in-memory and NOT durable across instances; configure UPSTASH_REDIS_REST_URL/TOKEN.";

  // ---- Load active alert ids (bounded per run to cap work) ----
  const ids = (await listActiveAlerts()).slice(0, 500);

  let checked = 0;
  let fired = 0;
  const errors: string[] = [];

  for (const id of ids) {
    checked++;

    // Load alert
    const alert = await getAlert(id);
    if (!alert) {
      // Stale id in set (key expired) — clean up silently.
      await markFired(id);
      continue;
    }

    // A fired alert stays active only while its webhook delivery is being retried.
    if (alert.fired) {
      if (alert.webhook && !alert.delivered && (alert.deliveryAttempts ?? 0) < MAX_DELIVERY_ATTEMPTS) {
        await deliverAlert(alert, errors);
      } else {
        await markFired(id, alert.firedPrice);
      }
      continue;
    }

    // Fetch current price
    let currentPrice: number;
    try {
      currentPrice = await fetchTokenPrice(alert.token);
    } catch (err) {
      errors.push(
        `${id}: price fetch failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    // Check crossing condition
    const crossed =
      alert.direction === "above"
        ? currentPrice >= alert.threshold
        : currentPrice <= alert.threshold;

    if (!crossed) continue;
    fired++;

    // Poll-mode alerts (no webhook) just record fired state for the caller to read.
    if (!alert.webhook) {
      await markFired(id, currentPrice);
      continue;
    }

    alert.fired = true;
    alert.firedAt = new Date().toISOString();
    alert.firedPrice = currentPrice;
    await deliverAlert(alert, errors);
  }

  // Also process rug-watch monitors (liquidity-collapse warnings).
  let rug = { checked: 0, fired: 0 };
  try {
    rug = await checkRugMonitors();
  } catch {
    /* best-effort */
  }

  return NextResponse.json({ checked, fired, rugWatch: rug, errors, ...(kvWarning ? { kvWarning } : {}) });
}
