/**
 * sinceLastCheck (R2) — turn a one-shot safety check into a relationship.
 *
 * The first time a caller checks a token we just record the score. Every LATER
 * paid check on the SAME token from the SAME caller gets a diff attached: what the
 * score was, how it moved, how long ago. A rising score on a token you hold is the
 * exact moment you re-check your exit — so the second check is worth more than the
 * first, and the caller comes back. Keyed by the pseudonymous source hash we
 * already compute for the coupon/rate-limit, so no new plumbing or payer decode.
 * That hash is an IP-derived approximation: callers behind a shared egress can
 * see each other's baseline, so the note words it as "from your network".
 */

import "server-only";
import { kvGet, kvSet } from "./kv";

const TTL = 60 * 60 * 24 * 60; // remember a caller's last score for 60 days

export interface SinceLast {
  previousScore: number;
  scoreDelta: number;
  previousLevel: string;
  previousAt: string;
  checkedAgo: string;
  direction: "worsened" | "improved" | "unchanged";
  note: string;
}

function ago(fromMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - fromMs) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Record this check and, if the caller has checked this token before, return the
 * diff. Returns null on the first-ever check (nothing to compare) or on KV miss —
 * callers attach the block only when non-null so first responses stay clean.
 */
export async function sinceLastCheck(
  src: string,
  addr: string,
  score: number,
  level: string,
): Promise<SinceLast | null> {
  const key = `lastcheck:${src}:${addr}`;
  let prev: { sc: number; lv: string; t: number } | null = null;
  try {
    const raw = await kvGet(key);
    if (raw) prev = JSON.parse(raw) as { sc: number; lv: string; t: number };
  } catch {
    prev = null;
  }
  // Always refresh the baseline to "now" so the diff is against the last check.
  await kvSet(key, JSON.stringify({ sc: score, lv: level, t: Date.now() }), TTL);

  if (!prev || typeof prev.sc !== "number") return null;
  const delta = score - prev.sc;
  return {
    previousScore: prev.sc,
    scoreDelta: delta,
    previousLevel: prev.lv || "",
    previousAt: new Date(prev.t).toISOString(),
    checkedAgo: ago(prev.t),
    direction: delta > 0 ? "worsened" : delta < 0 ? "improved" : "unchanged",
    note:
      delta > 0
        ? `⚠️ Risk is UP ${delta} pts since this token was last checked from your network (${ago(prev.t)}) — re-evaluate your position.`
        : delta < 0
          ? `Risk is down ${Math.abs(delta)} pts since the last check from your network (${ago(prev.t)}).`
          : `No change in score since the last check from your network (${ago(prev.t)}).`,
  };
}
