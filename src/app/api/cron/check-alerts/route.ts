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
  assertSafeWebhook,
} from "@/lib/alerts";
import { kvConfigured } from "@/lib/kv";
import { safeEqual } from "@/lib/secure";

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

    // Skip if somehow already fired (shouldn't normally appear in active set).
    if (alert.fired) {
      await markFired(id);
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

    // Re-validate webhook right before delivery (DNS-rebinding / TOCTOU defense).
    try {
      await assertSafeWebhook(alert.webhook);
    } catch (err) {
      errors.push(`${id}: webhook blocked — ${err instanceof Error ? err.message : String(err)}`);
      await markFired(id);
      continue;
    }

    // ---- Fire webhook ----
    const payload = {
      alertId: alert.id,
      token: alert.token,
      direction: alert.direction,
      threshold: alert.threshold,
      currentPrice,
      priceAtCreate: alert.priceAtCreate,
      createdAt: alert.createdAt,
      firedAt: new Date().toISOString(),
    };

    try {
      const webhookRes = await fetch(alert.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });

      if (!webhookRes.ok) {
        errors.push(
          `${id}: webhook returned ${webhookRes.status} — alert still fired`,
        );
      }
    } catch (err) {
      // Webhook failure is logged but does NOT block marking as fired —
      // we do not want to re-fire indefinitely on a bad endpoint.
      errors.push(
        `${id}: webhook POST failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Mark fired and remove from active set regardless of webhook outcome.
    await markFired(id);
    fired++;
  }

  return NextResponse.json({ checked, fired, errors, ...(kvWarning ? { kvWarning } : {}) });
}
