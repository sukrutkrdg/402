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
import net from "node:net";
import { lookup } from "node:dns/promises";
import { kvSet, kvGet, kvSAdd, kvSRem, kvSMembers } from "@/lib/kv";

// ---------------------------------------------------------------------------
// SSRF protection for caller-supplied webhook URLs
// ---------------------------------------------------------------------------

/** True if an IP literal is in a private / loopback / link-local / metadata range. */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("::ffff:")) return isPrivateIp(lower.replace("::ffff:", "")); // IPv4-mapped
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
  if (lower.startsWith("fe80")) return true; // link-local
  return false;
}

/**
 * Rejects webhook URLs that could be used for SSRF: non-https, localhost/.local,
 * private IP literals, or hostnames that resolve to private addresses. Called at
 * registration AND again by the cron right before delivery (DNS-rebinding defense).
 */
export async function assertSafeWebhook(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid webhook: must be a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("Invalid webhook: must be an https:// URL");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new Error("Invalid webhook: host not allowed");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Invalid webhook: private/internal address not allowed");
    return url;
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error("Invalid webhook: host could not be resolved");
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("Invalid webhook: resolves to a private/internal address");
  }
  return url;
}

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
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number };
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[] | null;
}

/** Fetch the current USD price for a token via DexScreener (base-token-matched pair). */
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

  const addrLc = token.toLowerCase();
  const highestLiq = (arr: DexScreenerPair[]) =>
    arr.reduce((top, p) => ((p.liquidity?.usd ?? 0) > (top.liquidity?.usd ?? 0) ? p : top), arr[0]);

  // Only trust pairs where the queried token is the BASE token (correct priceUsd).
  const baseMatches = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === addrLc);
  let price: number;
  if (baseMatches.length > 0) {
    price = parseFloat(highestLiq(baseMatches).priceUsd ?? "");
  } else {
    // Token only appears as quote — derive from base price / priceNative.
    const best = highestLiq(pairs);
    const baseUsd = parseFloat(best.priceUsd ?? "");
    const native = parseFloat(best.priceNative ?? "");
    price = native > 0 ? baseUsd / native : NaN;
  }

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

  // ---- Validate webhook (https + SSRF protection: no private/internal hosts) ----
  const webhook = (params.webhook || "").trim();
  if (!webhook) throw new Error("webhook is required");
  await assertSafeWebhook(webhook);

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
  // NOTE: we intentionally do NOT kvDel here — the 1-hour TTL above keeps the
  // fired alert briefly inspectable, then it expires on its own.
}

/** Convenience re-export of the price helper for use in the cron route. */
export { fetchTokenPrice };
