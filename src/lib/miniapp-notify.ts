/**
 * Farcaster Mini App notifications — the retention channel.
 *
 * When a user adds the mini app (sdk.actions.addMiniApp) their Farcaster client
 * POSTs a notification token + client URL to our webhook (/api/webhooks/farcaster).
 * We store those per-FID and can later push a notification that opens the app.
 *
 * Sending: POST {notificationId, title, body, targetUrl, tokens[]} to each
 * client's notification URL, ≤100 tokens per call. The client dedupes on
 * notificationId, so a stable id per campaign makes re-runs idempotent.
 */

import "server-only";
import { kvGet, kvSet, kvDel, kvSAdd, kvSRem, kvSMembers } from "./kv";

export interface NotifTarget {
  url: string; // the Farcaster client's notification endpoint
  token: string; // opaque per-user token minted by that client
  at: string;
}

const FIDS_KEY = "fcnotif:fids";
const MAX_TARGETS = 5000;

const fidKey = (fid: number) => `fcnotif:${fid}`;

export async function saveNotifTarget(fid: number, url: string, token: string): Promise<void> {
  const existing = await kvSMembers(FIDS_KEY);
  if (existing.length >= MAX_TARGETS && !existing.includes(String(fid))) return; // cap growth
  await kvSet(fidKey(fid), JSON.stringify({ url, token, at: new Date().toISOString() } satisfies NotifTarget));
  await kvSAdd(FIDS_KEY, String(fid));
}

export async function removeNotifTarget(fid: number): Promise<void> {
  await kvDel(fidKey(fid));
  await kvSRem(FIDS_KEY, String(fid));
}

export async function notifTargetCount(): Promise<number> {
  return (await kvSMembers(FIDS_KEY)).length;
}

export interface SendResult {
  targets: number;
  delivered: number;
  invalid: number;
  rateLimited: number;
}

/**
 * Push one notification to every registered user. title ≤32 chars, body ≤128,
 * targetUrl must be on our domain. `notificationId` should be stable per
 * campaign (e.g. "b20-seize-2026-07-16") — clients dedupe on it.
 */
export async function sendToAll(notificationId: string, title: string, body: string, targetUrl: string): Promise<SendResult> {
  const fids = await kvSMembers(FIDS_KEY);
  const byUrl = new Map<string, { fid: number; token: string }[]>();
  for (const f of fids) {
    const raw = await kvGet(fidKey(Number(f)));
    if (!raw) {
      await kvSRem(FIDS_KEY, f); // orphaned set entry
      continue;
    }
    try {
      const t = JSON.parse(raw) as NotifTarget;
      if (!/^https:\/\//.test(t.url) || !t.token) continue;
      const arr = byUrl.get(t.url) ?? [];
      arr.push({ fid: Number(f), token: t.token });
      byUrl.set(t.url, arr);
    } catch {
      /* skip malformed */
    }
  }

  const res: SendResult = { targets: fids.length, delivered: 0, invalid: 0, rateLimited: 0 };
  for (const [url, entries] of byUrl) {
    for (let i = 0; i < entries.length; i += 100) {
      const batch = entries.slice(i, i + 100);
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            notificationId,
            title: title.slice(0, 32),
            body: body.slice(0, 128),
            targetUrl,
            tokens: batch.map((b) => b.token),
          }),
          signal: AbortSignal.timeout(9000),
        });
        if (!r.ok) continue;
        const j = (await r.json()) as { successfulTokens?: string[]; invalidTokens?: string[]; rateLimitedTokens?: string[] };
        res.delivered += j.successfulTokens?.length ?? 0;
        res.rateLimited += j.rateLimitedTokens?.length ?? 0;
        for (const bad of j.invalidTokens ?? []) {
          res.invalid++;
          const owner = batch.find((b) => b.token === bad);
          if (owner) await removeNotifTarget(owner.fid); // token invalidated client-side
        }
      } catch {
        /* one client down shouldn't block the rest */
      }
    }
  }
  return res;
}
