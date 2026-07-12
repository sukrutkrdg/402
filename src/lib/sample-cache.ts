/**
 * Last-known-good sample — makes the 402 challenge sell.
 *
 * A payment challenge today shows an agent the PRICE but nothing of the VALUE,
 * so most callers bounce. We cache a PREVIEW of each service's most recent
 * successful response (the same redacted shape the free-tier teaser serves —
 * counts instead of details, no prose) and attach it to the 402 body, so the
 * agent's LLM sees what a paid call actually returns before deciding.
 *
 * Never computed at challenge time (running the handler unpaid would be a
 * cost-drain vector) — only read from KV, written on real successful serves.
 */

import "server-only";
import { kvGet, kvSet } from "./kv";
import { toPreview } from "./preview";

// Services whose responses mint per-caller secrets or capabilities (credit
// tokens, API tokens, monitor/watch ids, signed payloads). toPreview keeps
// short scalar strings, so a cached sample WOULD leak them — never sample.
const NO_SAMPLE = new Set(["buy-credits", "secure-token", "rug-monitor", "price-alert", "watchlist-diff", "pre-sign"]);

// Stale demo beats no demo, but two weeks past is no longer representative.
const SAMPLE_TTL = 60 * 60 * 24 * 14;

/** Cache a preview of a successful response as this service's shop-window sample. Best-effort. */
export async function saveSample(serviceId: string, data: unknown): Promise<void> {
  if (NO_SAMPLE.has(serviceId)) return;
  try {
    const preview = toPreview(data);
    if (Object.keys(preview).length === 0) return;
    await kvSet(`sample:${serviceId}`, JSON.stringify(preview), SAMPLE_TTL);
  } catch {
    /* sampling must never affect a serve */
  }
}

/** The cached sample for a service, or null when none has been captured yet. */
export async function loadSample(serviceId: string): Promise<Record<string, unknown> | null> {
  if (NO_SAMPLE.has(serviceId)) return null;
  try {
    const raw = await kvGet(`sample:${serviceId}`);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
