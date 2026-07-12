/**
 * Per-input preview cache.
 *
 * The free-tier teaser path runs the FULL handler once the daily free call is
 * used — that's a real upstream cost (GoPlus/DexScreener/CDP/RPC) for zero
 * revenue, so a bot replaying the preview endpoint could run up the owner's
 * bill. This caches the PREVIEW (already redacted, no secrets) keyed by service
 * + input, so a repeat preview for the same token serves from KV without
 * touching any upstream. Unlike sample-cache (global per service, for the 402
 * shop window), this is keyed by the caller's exact params so it returns the
 * RIGHT token's teaser, never a stale different one.
 *
 * Short TTL: a teaser can be a couple of minutes stale; the paid call is always
 * live. Combined with a tight rate limit on cache misses, this closes the
 * unpaid-preview cost-drain.
 */

import "server-only";
import { createHash } from "node:crypto";
import { kvGet, kvSet } from "./kv";

const PREVIEW_TTL = 120; // seconds — teaser freshness; paid calls are never cached

function keyFor(serviceId: string, params: Record<string, string>): string {
  // Stable across key order so the same inputs hash identically.
  const canon = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const h = createHash("sha256").update(canon).digest("hex").slice(0, 24);
  return `preview:${serviceId}:${h}`;
}

/** Cached preview object for this exact service+input, or null. Best-effort. */
export async function loadPreview(serviceId: string, params: Record<string, string>): Promise<Record<string, unknown> | null> {
  try {
    const raw = await kvGet(keyFor(serviceId, params));
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Store a preview object for this exact service+input. Best-effort. */
export async function savePreview(serviceId: string, params: Record<string, string>, preview: Record<string, unknown>): Promise<void> {
  try {
    await kvSet(keyFor(serviceId, params), JSON.stringify(preview), PREVIEW_TTL);
  } catch {
    /* caching must never affect a serve */
  }
}
