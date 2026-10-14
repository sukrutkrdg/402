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
 *   scout:results — newest first, cap 200, 30-day TTL refreshed on write. One
 *                   row per token the token-scout cron actually scanned: what
 *                   the scan computed (sell-side flags, rug-score level/score/
 *                   signals), which sources answered and which did not, and the
 *                   EAS attestation tx when the cron published one. Kept in its
 *                   own list so a scout run (up to 20 scans) cannot push paid
 *                   calls and alerts out of live:events; readFeed merges the two.
 *
 * What is stored is deliberately small and fixed. A paid call is service id +
 * price + time — never the payer. An alert firing is the token contract, the
 * alert type, the measured move and the time — never the alert/monitor id, the
 * webhook URL or its signing secret (an id is enough to poll somebody's monitor,
 * and a webhook URL identifies the customer). Readers re-build every event from
 * a whitelist, so a field that slipped into storage still never leaves.
 *
 * A scan row is a record of OUR check at a point in time — "our scan at T
 * flagged X" — not a verdict that a token is a scam; consumers present it that
 * way and link to a fresh re-check.
 *
 * Every write is best-effort: these lists describe a settlement or a firing that
 * has already happened, and must never be able to break it.
 */

import "server-only";
import { randomBytes } from "node:crypto";
import { kvExpire, kvLPush, kvLRange } from "./kv";

export const LIVE_KEYS = { feed: "live:events", alerts: "radar:alerts", scans: "scout:results" } as const;
export const FEED_CAP = 100;
export const ALERTS_CAP = 50;
export const SCANS_CAP = 200;
/** The list expires if the scout stops writing for this long, so a dead cron cannot leave old scans looking current. */
export const SCANS_TTL_SEC = 60 * 60 * 24 * 30;
/** At most this many scans take part in the merged live feed, so one scout run cannot crowd it. */
export const FEED_SCANS = 10;

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

export type ScanLevel = "high" | "medium" | "low" | "unknown";

export interface ScanEvent {
  kind: "scan";
  id: string;
  token: string;
  /** Symbol as GoPlus reported it during the scan; null when it did not answer. */
  symbol: string | null;
  /**
   * sell_side_flags: GoPlus reported honeypot / cannot-sell-all / sell tax >=30% (the rug score is not run then).
   * scored: the rug score ran (level/score below).
   * not_scored: no sell-side hit and the rug score could not be computed.
   */
  verdict: "sell_side_flags" | "scored" | "not_scored";
  /** Rug-score level as computed; null when the rug score was not run or failed. */
  level: ScanLevel | null;
  /** Rug score 0-100 as computed; null when not run or failed. */
  score: number | null;
  /** GoPlus sell-side findings, verbatim from the scan. */
  sellSideFlags: string[];
  /** Rug-score signals, verbatim from the scan. */
  riskSignals: string[];
  /** Sources that answered during this scan. */
  sources: string[];
  /** Sources the scan asked that did not answer. */
  sourcesMissing: string[];
  /** True when the scan could not check everything it normally checks (no "low" can be certified). */
  degraded: boolean;
  /** Base EAS attestation tx, only when the cron actually published one. */
  attestationTx: string | null;
  at: string;
}

export type LiveEvent = PaidCallEvent | AlertEvent | ScanEvent;

const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN = /^0x[0-9a-fA-F]{40}$/;
const EVENT_ID = /^[0-9a-z]{1,12}-[0-9a-f]{6}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const SOURCE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LEVELS: ReadonlySet<string> = new Set(["high", "medium", "low", "unknown"]);
const VERDICTS: ReadonlySet<string> = new Set(["sell_side_flags", "scored", "not_scored"]);

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

/** A free-text flag as our own code wrote it: printable, bounded. Anything else is dropped. */
function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return t || null;
}
function cleanList(v: unknown, maxItems: number, maxLen: number, re?: RegExp): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const t = cleanText(x, maxLen);
    if (t && (!re || re.test(t)) && !out.includes(t)) out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** What one token-scout scan computed. Built by the cron from its own results. */
export interface ScanInput {
  token: string;
  symbol: string | null;
  verdict: ScanEvent["verdict"];
  level: string | null;
  score: number | null;
  sellSideFlags: string[];
  riskSignals: string[];
  sources: string[];
  sourcesMissing: string[];
  degraded: boolean;
  attestationTx: string | null;
}

/** Record one token-scout scan. Never throws — the scan already happened; this is only its record. */
export async function recordScan(input: ScanInput, now = Date.now()): Promise<ScanEvent | null> {
  try {
    const ev = sanitizeEvent({ ...input, kind: "scan", id: newId(now), at: new Date(now).toISOString() });
    if (!ev || ev.kind !== "scan") return null;
    await kvLPush(LIVE_KEYS.scans, JSON.stringify(ev), SCANS_CAP);
    await kvExpire(LIVE_KEYS.scans, SCANS_TTL_SEC);
    return ev;
  } catch {
    return null;
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
  if (r.kind === "scan") {
    const token = typeof r.token === "string" && TOKEN.test(r.token) ? r.token.toLowerCase() : null;
    const verdict = typeof r.verdict === "string" && VERDICTS.has(r.verdict) ? (r.verdict as ScanEvent["verdict"]) : null;
    if (!token || !verdict) return null;
    const level = typeof r.level === "string" && LEVELS.has(r.level) ? (r.level as ScanLevel) : null;
    const score = finite(r.score);
    return {
      kind: "scan",
      id,
      token,
      symbol: cleanText(r.symbol, 32),
      verdict,
      level,
      score: score === null ? null : Math.max(0, Math.min(100, Math.round(score))),
      sellSideFlags: cleanList(r.sellSideFlags, 10, 120),
      riskSignals: cleanList(r.riskSignals, 12, 120),
      sources: cleanList(r.sources, 8, 32, SOURCE),
      sourcesMissing: cleanList(r.sourcesMissing, 8, 32, SOURCE),
      degraded: r.degraded === true,
      attestationTx: typeof r.attestationTx === "string" && TX_HASH.test(r.attestationTx) ? r.attestationTx.toLowerCase() : null,
      at,
    };
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

/**
 * Most recent feed events, newest first: paid calls and alert firings from
 * live:events merged with the newest scout scans (at most FEED_SCANS of them).
 */
export async function readFeed(limit = 30): Promise<LiveEvent[]> {
  const n = Math.max(0, limit - 1);
  const [feed, scans] = await Promise.all([
    kvLRange(LIVE_KEYS.feed, 0, n),
    kvLRange(LIVE_KEYS.scans, 0, Math.min(n, FEED_SCANS - 1)).catch(() => [] as string[]),
  ]);
  return [...parseList(feed), ...parseList(scans)]
    .sort((a, b) => eventTimeMs(b.id) - eventTimeMs(a.id))
    .slice(0, limit);
}

/** Most recent scout scans, newest first. */
export async function readScans(limit = 20): Promise<ScanEvent[]> {
  return parseList(await kvLRange(LIVE_KEYS.scans, 0, Math.max(0, limit - 1))).filter(
    (e): e is ScanEvent => e.kind === "scan",
  );
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

/** A scan as served publicly: the whitelisted record plus where to re-run the check and see the attestation. */
export interface PublicScan extends Omit<ScanEvent, "kind"> {
  /** Re-run the same rug score now (free daily trial on the paid endpoint). */
  recheck: string;
  attestationUrl: string | null;
}

export function publicScan(e: ScanEvent): PublicScan {
  return {
    id: e.id,
    token: e.token,
    symbol: e.symbol,
    verdict: e.verdict,
    level: e.level,
    score: e.score,
    sellSideFlags: e.sellSideFlags,
    riskSignals: e.riskSignals,
    sources: e.sources,
    sourcesMissing: e.sourcesMissing,
    degraded: e.degraded,
    attestationTx: e.attestationTx,
    at: e.at,
    recheck: `/api/x402/rug-score?address=${e.token}&free=1`,
    attestationUrl: e.attestationTx ? `https://base.easscan.org/attestation/tx/${e.attestationTx}` : null,
  };
}
