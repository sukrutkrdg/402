/**
 * Tell the operator when something is wrong that only they can fix.
 *
 * The Anthropic balance ran dry on 2026-08-20 and every AI endpoint — the ten
 * highest-priced things we sell — answered 400 for hours. The health probe that
 * detects this exactly had already been written; what it did with the answer was
 * put it in a response body, on a route nothing called, because it was never
 * added to the schedule. A detector nobody reads is not a detector.
 *
 * Two properties matter more than the channel:
 *
 *   - It must not be able to break the thing it watches. Every failure here is
 *     swallowed; an alert that throws inside a cron would take down the run it
 *     was supposed to report on.
 *   - Delivery is optional. The incident is recorded in KV whichever way, and
 *     /api/revenue renders it at the top of the stats panel — that is the
 *     channel the operator actually reads. Telegram is a convenience for
 *     anyone who sets OWNER_TELEGRAM_CHAT_ID and is off by default.
 *   - It must not repeat itself daily. An outage that pages once is a signal; one
 *     that pages every morning becomes a filter rule, and then the next real
 *     alert is invisible too. So an incident is announced once, and again only
 *     when it clears.
 */

import "server-only";
import { kvGet, kvSet, kvDel } from "./kv";

/** Long enough that a daily cron never re-announces a standing incident. */
const REPEAT_AFTER_SECONDS = 60 * 60 * 20;

/**
 * Every alert kind, most severe first.
 *
 * This is the ONLY list. /api/revenue used to keep its own copy, which is how
 * `index-gap` came to be written to KV and rendered nowhere — the panel that
 * exists to stop detectors going unread had a detector it could not see. A kind
 * added to the type but not to this array fails to compile, so the next one
 * cannot repeat it.
 *
 * Order is what a person should deal with first: an outage that stops the AI
 * endpoints selling outranks a discovery gap, which outranks a wallet running
 * low, which outranks a stale published surface. `stock-actions` sits at the
 * end because it is not a fault — it fires once, when something happens that
 * has never happened before.
 */
export const ALERT_KINDS = [
  "ai-credits",
  "index-gap",
  "buyer-funds",
  "surfaces",
  "stock-actions",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export interface AlertOutcome {
  fired: boolean;
  delivered: boolean;
  reason?: string;
}

async function sendTelegram(text: string): Promise<{ ok: boolean; reason?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.OWNER_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    return { ok: false, reason: "OWNER_TELEGRAM_CHAT_ID/TELEGRAM_BOT_TOKEN not set" };
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? { ok: true } : { ok: false, reason: `telegram ${r.status}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 80) : "send failed" };
  }
}

/**
 * Raise `kind`. Announces once, then stays quiet until it clears.
 *
 * The incident is recorded in KV whether or not delivery works, so an
 * unconfigured channel still leaves a trail an owner-only surface can show —
 * losing the fact because the messenger was missing would repeat the original
 * mistake in a new place.
 */
export async function alertOwner(kind: AlertKind, text: string): Promise<AlertOutcome> {
  try {
    const key = `incident:${kind}`;
    const open = await kvGet(key);
    await kvSet(key, JSON.stringify({ text, since: open ? JSON.parse(open).since ?? new Date().toISOString() : new Date().toISOString(), lastSeen: new Date().toISOString() }), REPEAT_AFTER_SECONDS + 86400);
    if (open) return { fired: false, delivered: false, reason: "already announced" };
    const sent = await sendTelegram(`⚠️ 402.com.tr\n\n${text}`);
    return { fired: true, delivered: sent.ok, reason: sent.reason };
  } catch {
    return { fired: false, delivered: false, reason: "alerting failed" };
  }
}

/** Announce that `kind` is over, but only if it was ever announced. */
export async function clearAlert(kind: AlertKind, text: string): Promise<AlertOutcome> {
  try {
    const key = `incident:${kind}`;
    if (!(await kvGet(key))) return { fired: false, delivered: false };
    await kvDel(key);
    const sent = await sendTelegram(`✅ 402.com.tr\n\n${text}`);
    return { fired: true, delivered: sent.ok, reason: sent.reason };
  } catch {
    return { fired: false, delivered: false, reason: "alerting failed" };
  }
}

/** Open incidents, for an owner-only surface to render. */
export async function openIncident(kind: AlertKind): Promise<{ text: string; since: string } | null> {
  try {
    const raw = await kvGet(`incident:${kind}`);
    return raw ? (JSON.parse(raw) as { text: string; since: string }) : null;
  } catch {
    return null;
  }
}
