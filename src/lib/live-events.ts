/**
 * Recorded events for /radar and the live feed (/api/events/live).
 *
 * Two capped KV lists, written only at the points where the thing actually
 * happens — nothing here is generated, sampled or replayed:
 *
 *   live:events   — newest first, cap 100. Paid calls by OUTSIDE payers (written
 *                   from recordExternalRevenue, which the x402 path calls only
 *                   after settlement and only when the signer is not us) and
 *                   alert firings.
 *   radar:alerts  — newest first, cap 50. Alert firings only, so a burst of paid
 *                   calls cannot push them off the radar page.
 *
 * What is stored is deliberately small and fixed. A paid call is service id +
 * price + time — never the payer. An alert firing is the token contract, the
 * alert type, the measured move and the time — never the alert/monitor id, the
 * webhook URL or its signing secret (an id is enough to poll somebody's monitor,
 * and a webhook URL identifies the customer). Readers re-build every event from
 * a whitelist, so a field that slipped into storage still never leaves.
 *
 * Every write is best-effort: these lists describe a settlement or a firing that
 * has already happened, and must never be able to break it.
 */

import "server-only";
import { randomBytes } from "node:crypto";
import { kvLPush, kvLRange } from "./kv";

export const LIVE_KEYS = { feed: "live:events", alerts: "radar:alerts" } as const;
export const FEED_CAP = 100;
export const ALERTS_CAP = 50;

export interface PaidCallEvent {
  kind: "paid_call";
  id: string;
  service: string;
  priceUsd: number;
  at: string;
}

export interface AlertEvent {
  kind: "alert";
  id: string;
  /** price_alert: a subscriber's price threshold was crossed. rug_warning: a watched pool's liquidity fell past a subscriber's threshold. */
  type: "price_alert" | "rug_warning";
  token: string;
  /** Signed %, measured at firing. price_alert: price change since the alert was created. rug_warning: liquidity change from the baseline (negative = drained). */
  changePct: number | null;
  /** price_alert only: which side of the threshold was crossed. */
  direction?: "above" | "below";
  at: string;
}

export type LiveEvent = PaidCallEvent | AlertEvent;

const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN = /^0x[0-9a-fA-F]{40}$/;
const EVENT_ID = /^[0-9a-z]{1,12}-[0-9a-f]{6}$/;

/** `<ms base36>-<6 hex>` — sortable by time, unique enough to dedupe on reconnect. */
function newId(atMs: number): string {
  return `${atMs.toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** Event time in ms, taken from its id (ids are minted from the event's own timestamp). */
export function eventTimeMs(id: string): number {
  const ms = parseInt(id.split("-")[0] ?? "", 36);
  return Number.isFinite(ms) ? ms : 0;
}

const finite = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

/** Record one paid call by an outside payer. No payer, no request data — service, price, time. */
export async function recordPaidCall(serviceId: string, mills: number, now = Date.now()): Promise<void> {
  try {
    if (!SERVICE_ID.test(serviceId) || !Number.isFinite(mills) || mills <= 0) return;
    const ev: PaidCallEvent = {
      kind: "paid_call",
      id: newId(now),
      service: serviceId,
      priceUsd: Math.round(mills) / 1000,
      at: new Date(now).toISOString(),
    };
    await kvLPush(LIVE_KEYS.feed, JSON.stringify(ev), FEED_CAP);
  } catch {
    /* the settlement already happened; this is only its echo */
  }
}

/** Record one alert firing — called exactly where a price alert or rug-watch fires. */
export async function recordAlertFiring(
  input: { type: AlertEvent["type"]; token: string; changePct: number | null; direction?: "above" | "below" },
  now = Date.now(),
): Promise<void> {
  try {
    if (!TOKEN.test(input.token)) return;
    if (input.type !== "price_alert" && input.type !== "rug_warning") return;
    const pct = finite(input.changePct);
    const ev: AlertEvent = {
      kind: "alert",
      id: newId(now),
      type: input.type,
      token: input.token.toLowerCase(),
      changePct: pct === null ? null : +pct.toFixed(1),
      ...(input.type === "price_alert" && (input.direction === "above" || input.direction === "below")
        ? { direction: input.direction }
        : {}),
      at: new Date(now).toISOString(),
    };
    const json = JSON.stringify(ev);
    await Promise.all([kvLPush(LIVE_KEYS.feed, json, FEED_CAP), kvLPush(LIVE_KEYS.alerts, json, ALERTS_CAP)]);
  } catch {
    /* the alert already fired and was delivered; this is only its echo */
  }
}

/** Re-build an event from the whitelist; anything malformed is dropped, never repaired into something else. */
export function sanitizeEvent(raw: unknown): LiveEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && EVENT_ID.test(r.id) ? r.id : null;
  const at = typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : null;
  if (!id || !at) return null;
  if (r.kind === "paid_call") {
    const service = typeof r.service === "string" && SERVICE_ID.test(r.service) ? r.service : null;
    const priceUsd = finite(r.priceUsd);
    if (!service || priceUsd === null || priceUsd <= 0) return null;
    return { kind: "paid_call", id, service, priceUsd, at };
  }
  if (r.kind === "alert") {
    const type = r.type === "price_alert" || r.type === "rug_warning" ? r.type : null;
    const token = typeof r.token === "string" && TOKEN.test(r.token) ? r.token.toLowerCase() : null;
    if (!type || !token) return null;
    const direction = r.direction === "above" || r.direction === "below" ? r.direction : undefined;
    return { kind: "alert", id, type, token, changePct: finite(r.changePct), ...(direction && type === "price_alert" ? { direction } : {}), at };
  }
  return null;
}

function parseList(rows: string[]): LiveEvent[] {
  const out: LiveEvent[] = [];
  for (const row of rows) {
    try {
      const ev = sanitizeEvent(JSON.parse(row));
      if (ev) out.push(ev);
    } catch {
      /* skip a corrupt row */
    }
  }
  return out;
}

/** Most recent feed events, newest first. */
export async function readFeed(limit = 30): Promise<LiveEvent[]> {
  return parseList(await kvLRange(LIVE_KEYS.feed, 0, Math.max(0, limit - 1)));
}

/** Most recent alert firings, newest first. */
export async function readAlertFirings(limit = 20): Promise<AlertEvent[]> {
  return parseList(await kvLRange(LIVE_KEYS.alerts, 0, Math.max(0, limit - 1))).filter(
    (e): e is AlertEvent => e.kind === "alert",
  );
}

// One KV read per instance per window, however many streams are open on it.
let shared: { at: number; p: Promise<LiveEvent[]> } | null = null;

/** readFeed, memoised per instance for `maxAgeMs` so N open streams cost one LRANGE per poll, not N. */
export function readFeedShared(maxAgeMs = 4000, limit = 30): Promise<LiveEvent[]> {
  const now = Date.now();
  if (shared && now - shared.at < maxAgeMs) return shared.p;
  const p = readFeed(limit).catch(() => [] as LiveEvent[]);
  shared = { at: now, p };
  return p;
}

/** Test hook. */
export function resetFeedShare(): void {
  shared = null;
}
