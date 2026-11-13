/**
 * Per-instance snapshot cache for expensive KV-backed reads on public surfaces.
 *
 * Two jobs, learned the hard way on 2026-11-12, when the free Upstash tier's
 * monthly quota ran out in six days:
 *
 *   1. COALESCE: /leaderboard, /status and their JSON routes became
 *      force-dynamic to stop build-time prerenders crashing on a KV blip — which
 *      also made every request (mostly crawlers) pay the full KV read. A warm
 *      instance now answers repeats from memory for `ttlMs`.
 *   2. LAST GOOD: when the refresh fails (rate limit, quota), serve the last
 *      snapshot marked degraded instead of a 500. The reader that throws on
 *      failure is right that an empty week must not be presented as a quiet
 *      week — but a stale real week, labelled stale, beats an error page.
 *
 * Per instance only (resets on cold start); that is the point — it bounds the
 * KV cost per warm instance without pretending to be a shared cache.
 */

import "server-only";

interface Slot<T> {
  at: number;
  value: T;
}

const slots = new Map<string, Slot<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export interface Snapshot<T> {
  value: T;
  /** When the value was actually read. */
  at: string;
  /** True when this is an old snapshot served because the refresh failed. */
  stale: boolean;
}

/**
 * Serve `fn`'s result cached for `ttlMs` per instance. Within the TTL the cached
 * value is returned without calling `fn`. After it, `fn` runs once (concurrent
 * callers share the same refresh); on failure the previous snapshot is served
 * with `stale: true`, and only a failure with NO previous snapshot rethrows.
 */
export async function snapshot<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<Snapshot<T>> {
  const now = Date.now();
  const have = slots.get(key) as Slot<T> | undefined;
  if (have && now - have.at < ttlMs) return { value: have.value, at: new Date(have.at).toISOString(), stale: false };

  let p = inflight.get(key) as Promise<T> | undefined;
  if (!p) {
    p = fn();
    inflight.set(key, p);
    p.finally(() => inflight.delete(key)).catch(() => {});
  }
  try {
    const value = await p;
    slots.set(key, { at: now, value });
    return { value, at: new Date(now).toISOString(), stale: false };
  } catch (err) {
    if (have) return { value: have.value, at: new Date(have.at).toISOString(), stale: true };
    throw err;
  }
}

/** Test hook. */
export function resetSnapshots(): void {
  slots.clear();
  inflight.clear();
}
