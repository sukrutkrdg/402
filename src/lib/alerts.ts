/**
 * Price-alert service for the x402 Bazaar.
 *
 * Agents pay once to register a threshold alert on any Base token.
 * A cron job (src/app/api/cron/check-alerts/route.ts) polls DexScreener
 * and POSTs a JSON payload to the caller-supplied webhook when the price
 * crosses the threshold.
 *
 * Storage: KV keys
 *   alert:{id}        — JSON-serialised Alert object (TTL 30 days)
 *   alerts:active     — set of ids that have not yet fired / expired
 */

import "server-only";
import { kvSet, kvGet, kvDel, kvSAdd, kvSRem, kvSMembers } from "@/lib/kv";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Alert {
  id: string;
  token: string;
  threshold: number;
  direction: "above" | "below";
  webhook: string;
  priceAtCreate: number;
  createdAt: string;
  fired: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ALERT_TTL = 60 * 60 * 24 * 30; // 30 days in seconds

interface DexScreenerPair {
  priceUsd?: string;
  liquidity?: { usd?: number };
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[] | null;
}

/** Fetch the current USD price for a token via DexScreener (highest-liquidity pair). */
async function fetchTokenPrice(token: string): Promise<number> {
  let data: DexScreenerResponse;
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${token}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`DexScreener responded ${res.status}`);
    data = (await res.json()) as DexScreenerResponse;
  } catch (err) {
    throw new Error(
      `Price fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const pairs = data.pairs?.filter(Boolean) ?? [];
  if (pairs.length === 0) throw new Error("No price data for token");

  // Pick the pair with the greatest USD liquidity — most reliable price source.
  const best = pairs.reduce<DexScreenerPair>((top, p) => {
    const topLiq = top.liquidity?.usd ?? 0;
    const pLiq = p.liquidity?.usd ?? 0;
    return pLiq > topLiq ? p : top;
  }, pairs[0]);

  if (!best.priceUsd) throw new Error("No price data for token");

  const price = parseFloat(best.priceUsd);
  if (!Number.isFinite(price)) throw new Error("No price data for token");
  return price;
}

// ---------------------------------------------------------------------------
// Paid service handler — called by the x402 middleware on successful payment
// ---------------------------------------------------------------------------

/**
 * registerAlert — the paid entry point.
 *
 * Validates inputs strictly so x402 never charges for a bad request.
 * Fetches the live price at registration time and stores the alert in KV.
 *
 * Required params:
 *   token     — 0x…40-hex Base token contract address
 *   threshold — positive USD price number
 *   direction — "above" | "below"
 *   webhook   — https:// URL that will receive a POST when the alert fires
 */
export async function registerAlert(
  params: Record<string, string>,
): Promise<unknown> {
  // ---- Validate token ----
  const token = (params.token || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    throw new Error(
      "Invalid token: must be a 0x… 40-hex Base contract address",
    );
  }

  // ---- Validate threshold ----
  const thresholdRaw = (params.threshold || "").trim();
  const threshold = parseFloat(thresholdRaw);
  if (!thresholdRaw || !Number.isFinite(threshold) || threshold <= 0) {
    throw new Error("Invalid threshold: must be a positive number");
  }

  // ---- Validate direction ----
  const direction = (params.direction || "").trim() as "above" | "below";
  if (direction !== "above" && direction !== "below") {
    throw new Error('Invalid direction: must be "above" or "below"');
  }

  // ---- Validate webhook ----
  const webhook = (params.webhook || "").trim();
  if (!webhook) throw new Error("webhook is required");
  let parsedWebhook: URL;
  try {
    parsedWebhook = new URL(webhook);
  } catch {
    throw new Error("Invalid webhook: must be a valid URL");
  }
  if (parsedWebhook.protocol !== "https:") {
    throw new Error("Invalid webhook: must be an https:// URL");
  }

  // ---- Fetch current price (throws if unavailable — prevents charge on failure) ----
  const currentPrice = await fetchTokenPrice(token);

  // ---- Create and persist alert ----
  const id = `alrt_${crypto.randomUUID().slice(0, 12)}`;
  const createdAt = new Date().toISOString();

  const alert: Alert = {
    id,
    token,
    threshold,
    direction,
    webhook,
    priceAtCreate: currentPrice,
    createdAt,
    fired: false,
  };

  await kvSet(`alert:${id}`, JSON.stringify(alert), ALERT_TTL);
  await kvSAdd("alerts:active", id);

  return {
    alertId: id,
    token,
    threshold,
    direction,
    currentPrice,
    webhook,
    message:
      "Alert registered. You'll receive a webhook POST when crossed.",
    createdAt,
  };
}

// ---------------------------------------------------------------------------
// Cron helpers
// ---------------------------------------------------------------------------

/** Returns all alert ids that are currently active (not fired / expired). */
export async function listActiveAlerts(): Promise<string[]> {
  return kvSMembers("alerts:active");
}

/** Loads and deserialises a single alert. Returns null if missing/expired. */
export async function getAlert(id: string): Promise<Alert | null> {
  const raw = await kvGet(`alert:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Alert;
  } catch {
    return null;
  }
}

/**
 * Marks an alert as fired, removes it from the active set, and deletes its
 * KV key (the TTL would clean it up eventually, but removing eagerly keeps
 * the active-set accurate and avoids redundant checks).
 */
export async function markFired(id: string): Promise<void> {
  const raw = await kvGet(`alert:${id}`);
  if (raw) {
    try {
      const alert: Alert = { ...(JSON.parse(raw) as Alert), fired: true };
      // Keep the key briefly (1 h) so callers can inspect it post-fire.
      await kvSet(`alert:${id}`, JSON.stringify(alert), 3600);
    } catch {
      /* best-effort update */
    }
  }
  await kvSRem("alerts:active", id);
  await kvDel(`alert:${id}`);
}

/** Convenience re-export of the price helper for use in the cron route. */
export { fetchTokenPrice };
