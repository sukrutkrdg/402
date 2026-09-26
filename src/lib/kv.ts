/**
 * Tiny KV abstraction.
 *
 * Uses Upstash Redis REST (or Vercel KV, which is Upstash under the hood) when
 * configured via env, else falls back to an in-memory Map (per-instance, resets
 * on cold start). This lets durability be opt-in: the app works today, and
 * becomes globally consistent the moment you set the env vars.
 *
 * Env (either pair works):
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 *   KV_REST_API_URL        / KV_REST_API_TOKEN
 */

import "server-only";

const URL_ENV = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const TOKEN_ENV = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";

export function kvConfigured(): boolean {
  return Boolean(URL_ENV && TOKEN_ENV);
}

// ---- in-memory fallback ----
type Entry = { value: string; expireAt?: number };
const mem = new Map<string, Entry>();
const memList = new Map<string, string[]>();
const memHash = new Map<string, Map<string, number>>();

function memValid(k: string): Entry | undefined {
  const e = mem.get(k);
  if (!e) return undefined;
  if (e.expireAt && Date.now() > e.expireAt) {
    mem.delete(k);
    return undefined;
  }
  return e;
}

// ---- Upstash REST command ----
// Single attempt, distinguishing a TRANSPORT failure (fetch threw / non-2xx —
// e.g. a rate-limited 429) from a successful read whose value is genuinely null
// (missing key). Callers that must not surface a transient failure as a real "0"
// use this via cmdRead() to retry only the transport-failure case.
async function cmdOnce<T = unknown>(args: (string | number)[]): Promise<{ ok: boolean; result: T | null }> {
  try {
    const res = await fetch(URL_ENV, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_ENV}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, result: null };
    const j = (await res.json()) as { result?: T; error?: string };
    // Upstash reports some failures — notably "Your database has been
    // temporarily rate-limited" when a plan's limit is hit — as HTTP 200 with an
    // `error` body. Reading only the status turned those into a successful null:
    // writes vanished and reads looked like empty keys, so every fail-closed
    // guard built on "null means KV failed" was bypassed without a trace.
    if (j.error) {
      noteKvError(j.error);
      return { ok: false, result: null };
    }
    return { ok: true, result: (j.result ?? null) as T | null };
  } catch {
    return { ok: false, result: null };
  }
}

let lastKvErrorLog = 0;
/** Log a KV error body at most once a minute per instance — loud enough to be seen, not per request. */
function noteKvError(error: string) {
  const now = Date.now();
  if (now - lastKvErrorLog < 60_000) return;
  lastKvErrorLog = now;
  console.error(`[kv] Upstash refused a command: ${error.slice(0, 200)}`);
}

async function cmd<T = unknown>(args: (string | number)[]): Promise<T | null> {
  return (await cmdOnce<T>(args)).result;
}

/**
 * Read-only command with bounded retry on TRANSPORT failure only. A valid null
 * result (missing key) returns immediately — so legitimately-empty counters cost
 * one call, while a rate-limited/timed-out read (the cause of the dashboard's
 * numbers flickering to 0) is retried instead of returning a false null. Never
 * use for writes — a retried INCR/LPUSH could double-apply.
 */
async function cmdRead<T = unknown>(args: (string | number)[]): Promise<T | null> {
  for (let i = 0; i < 3; i++) {
    const r = await cmdOnce<T>(args);
    if (r.ok) return r.result;
    if (i < 2) await new Promise((res) => setTimeout(res, 150 * (i + 1)));
  }
  return null; // persistent transport failure — caller decides (0 / degraded)
}

/**
 * Run several commands in ONE REST round trip (Upstash /pipeline endpoint).
 * Returns per-command results, or null when the whole request failed. Use for
 * multi-write paths (analytics) so each request costs one round trip, not N.
 */
export async function kvPipeline(commands: (string | number)[][]): Promise<unknown[] | null> {
  if (!kvConfigured()) return null;
  try {
    const res = await fetch(`${URL_ENV}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_ENV}`, "content-type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Array<{ result?: unknown }>;
    return j.map((r) => r.result ?? null);
  } catch {
    return null;
  }
}

/**
 * Should this instance (re)send EXPIRE for `key` now?
 *
 * Analytics and counters used to send EXPIRE with every INCR/SADD — on the
 * unpaid-402 path that was a third of the commands a request cost, and the
 * Upstash plan limit is counted in commands. A TTL only has to be refreshed
 * before it can lapse, so each instance re-sends it at most once per half-TTL
 * (capped at an hour). That keeps the guarantee that a key never outlives its
 * TTL by more than the TTL itself: a key re-created after expiring is touched
 * again after the half-TTL mark, which re-sends EXPIRE before it could lapse.
 */
const ttlSentAt = new Map<string, number>();
export function ttlDue(key: string, ttlSeconds: number): boolean {
  const now = Date.now();
  const every = Math.min(ttlSeconds * 500, 3_600_000); // half the TTL, in ms, at most 1h
  const at = ttlSentAt.get(key);
  if (at !== undefined && now - at < every) return false;
  if (ttlSentAt.size > 5000) ttlSentAt.clear(); // bound memory; worst case re-sends once
  ttlSentAt.set(key, now);
  return true;
}

/**
 * Increment a counter; set TTL (seconds) when requested. Returns the new value,
 * or NULL when KV is configured but unreachable — callers guarding money or
 * quota MUST treat null as "deny" (fail closed), never as 0. A silent 0 here is
 * what previously turned every KV outage into an unlimited free tier.
 */
export async function kvIncr(key: string, ttlSeconds?: number): Promise<number | null> {
  if (kvConfigured()) {
    // Single round trip: INCR + EXPIRE pipelined. TTL is always (re)set so a key
    // never persists without expiry; daily reset comes from the date in the key.
    if (ttlSeconds && ttlDue(key, ttlSeconds)) {
      const results = await kvPipeline([["INCR", key], ["EXPIRE", key, ttlSeconds]]);
      const n = results?.[0];
      return typeof n === "number" ? n : null;
    }
    return await cmd<number>(["INCR", key]);
  }
  const e = memValid(key);
  const n = (e ? parseInt(e.value, 10) || 0 : 0) + 1;
  mem.set(key, { value: String(n), expireAt: e?.expireAt ?? (ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined) });
  return n;
}

/**
 * Atomically add `by` to a counter and return the new value (or null on failure).
 * Redis INCRBY/DECRBY are atomic, so this is safe for the prepaid-credit ledger:
 * two concurrent debits can't both overdraw — one lands below zero and is refunded
 * by the caller. Money-path callers MUST treat null as "fail closed".
 */
export async function kvIncrBy(key: string, by: number): Promise<number | null> {
  if (kvConfigured()) return await cmd<number>(["INCRBY", key, by]);
  const e = memValid(key);
  const n = (e ? parseInt(e.value, 10) || 0 : 0) + by;
  mem.set(key, { value: String(n), expireAt: e?.expireAt });
  return n;
}

export async function kvDecrBy(key: string, by: number): Promise<number | null> {
  if (kvConfigured()) return await cmd<number>(["DECRBY", key, by]);
  const e = memValid(key);
  const n = (e ? parseInt(e.value, 10) || 0 : 0) - by;
  mem.set(key, { value: String(n), expireAt: e?.expireAt });
  return n;
}

export async function kvGetNumber(key: string): Promise<number> {
  if (kvConfigured()) {
    const v = await cmd<string>(["GET", key]);
    return v ? parseInt(v, 10) || 0 : 0;
  }
  const e = memValid(key);
  return e ? parseInt(e.value, 10) || 0 : 0;
}

/**
 * Number read with retry on transient failure — for the handful of HOT SINGLETON
 * counters (usage:calls:total etc.) whose flicker to a false 0 is user-visible.
 * NOT for bulk/per-service reads: firing hundreds of these in parallel would let
 * retries pile up under rate-limiting and stall the request.
 */
export async function kvGetNumberStable(key: string): Promise<number> {
  if (kvConfigured()) {
    const v = await cmdRead<string>(["GET", key]);
    return v ? parseInt(v, 10) || 0 : 0;
  }
  const e = memValid(key);
  return e ? parseInt(e.value, 10) || 0 : 0;
}

export async function kvGet(key: string): Promise<string | null> {
  if (kvConfigured()) return await cmd<string>(["GET", key]);
  return memValid(key)?.value ?? null;
}

export async function kvSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  if (kvConfigured()) {
    await cmd(ttlSeconds ? ["SET", key, value, "EX", ttlSeconds] : ["SET", key, value]);
    return;
  }
  mem.set(key, { value, expireAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined });
}

/**
 * SET that reports whether the write landed, from the write's own reply.
 *
 * Do not confirm a write by reading it back: an Upstash global database serves
 * reads from the nearest replica, so a GET issued right after a SET can miss it.
 * The primary's "OK" is the confirmation.
 *
 * On failure `detail` says why — the HTTP status and Upstash's own error text
 * (a quota or rate limit reads very differently from a timeout), so a failed
 * money path can be diagnosed from its response instead of guessed at.
 */
export async function kvSetChecked(
  key: string,
  value: string,
  ttlSeconds?: number,
): Promise<{ ok: boolean; detail?: string }> {
  if (!kvConfigured()) {
    mem.set(key, { value, expireAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined });
    return { ok: true };
  }
  const args = ttlSeconds ? ["SET", key, value, "EX", ttlSeconds] : ["SET", key, value];
  try {
    const res = await fetch(URL_ENV, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_ENV}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    let j: { result?: unknown; error?: string } = {};
    try {
      j = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    if (res.ok && j.result === "OK") return { ok: true };
    return { ok: false, detail: `kv HTTP ${res.status}: ${(j.error || text || res.statusText).slice(0, 160)}` };
  } catch (err) {
    return { ok: false, detail: `kv request failed: ${(err as Error).name}: ${(err as Error).message}`.slice(0, 200) };
  }
}

export async function kvDel(key: string): Promise<void> {
  if (kvConfigured()) {
    await cmd(["DEL", key]);
    return;
  }
  mem.delete(key);
}

/**
 * Atomic reserve: set `key` only if it doesn't already exist (SET … NX EX).
 * Returns true if THIS caller won the reservation, false if it was already held.
 * Use to make "check then claim" one step so concurrent requests can't both pass
 * (e.g. one settlement tx redeeming many reports). Fails CLOSED (returns false)
 * when KV is unavailable, so a reservation is never falsely granted.
 */
/**
 * Run a Lua script server-side (Upstash EVAL). Redis executes it atomically, so
 * a guard and the write it guards land together or not at all — which is the
 * only way to make a write safe to retry over a transport that can lose the
 * reply to a command that already ran. See `kvIncrByOnce`.
 *
 * Null means the request itself failed; a script that ran returns its value.
 */
export async function kvEval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T | null> {
  if (!kvConfigured()) return null;
  return await cmd<T>(["EVAL", script, keys.length, ...keys, ...args]);
}

/**
 * Add `by` to `key`, at most once per `guardKey`, however many times it is called.
 *
 * A plain INCRBY cannot be retried: a timeout returns no answer, and "no answer"
 * is not "no write" — the command may well have executed and only the reply got
 * lost. Retrying it blind applies it twice. Doing it under a SET-NX guard inside
 * one script removes the ambiguity, because the guard is proof: if it is already
 * there, this increment has run, so a retry is free to give up rather than
 * double-apply.
 *
 * Returns the new value, `null` when the request failed (safe to retry with the
 * SAME guard key), or `ALREADY` when the guard shows it had already been applied.
 */
export const ALREADY = Symbol.for("kv.already");
const INCR_ONCE = `
if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3]) then
  return redis.call('INCRBY', KEYS[2], ARGV[1])
end
return ARGV[2]
`;
export async function kvIncrByOnce(
  key: string,
  by: number,
  guardKey: string,
  guardTtlSeconds = 60 * 60 * 24,
): Promise<number | typeof ALREADY | null> {
  const SENTINEL = "__already__";
  if (!kvConfigured()) {
    if (memValid(guardKey)) return ALREADY;
    mem.set(guardKey, { value: "1", expireAt: Date.now() + guardTtlSeconds * 1000 });
    const e = memValid(key);
    const n = (e ? parseInt(e.value, 10) || 0 : 0) + by;
    mem.set(key, { value: String(n), expireAt: e?.expireAt });
    return n;
  }
  const r = await kvEval<number | string>(INCR_ONCE, [guardKey, key], [by, SENTINEL, guardTtlSeconds]);
  if (r === null) return null;
  return r === SENTINEL ? ALREADY : Number(r);
}

export async function kvSetNx(key: string, ttlSeconds: number): Promise<boolean> {
  if (kvConfigured()) {
    const r = await cmd<string>(["SET", key, "1", "NX", "EX", ttlSeconds]);
    return r === "OK";
  }
  // In-memory fallback (single instance): emulate NX honoring TTL.
  if (memValid(key)) return false;
  mem.set(key, { value: "1", expireAt: Date.now() + ttlSeconds * 1000 });
  return true;
}

/** Push to the head of a list (capped via LTRIM). */
export async function kvLPush(key: string, value: string, capTo = 200): Promise<void> {
  if (kvConfigured()) {
    await cmd(["LPUSH", key, value]);
    await cmd(["LTRIM", key, 0, capTo - 1]);
    return;
  }
  const arr = memList.get(key) ?? [];
  arr.unshift(value);
  memList.set(key, arr.slice(0, capTo));
}

export async function kvLRange(key: string, start = 0, stop = -1): Promise<string[]> {
  if (kvConfigured()) return (await cmd<string[]>(["LRANGE", key, start, stop])) ?? [];
  const arr = memList.get(key) ?? [];
  return stop === -1 ? arr.slice(start) : arr.slice(start, stop + 1);
}

/** Add to a set. */
export async function kvSAdd(key: string, member: string): Promise<void> {
  if (kvConfigured()) {
    await cmd(["SADD", key, member]);
    return;
  }
  const arr = memList.get(`set:${key}`) ?? [];
  if (!arr.includes(member)) arr.push(member);
  memList.set(`set:${key}`, arr);
}

export async function kvSRem(key: string, member: string): Promise<void> {
  if (kvConfigured()) {
    await cmd(["SREM", key, member]);
    return;
  }
  const arr = (memList.get(`set:${key}`) ?? []).filter((m) => m !== member);
  memList.set(`set:${key}`, arr);
}

export async function kvSMembers(key: string): Promise<string[]> {
  if (kvConfigured()) return (await cmd<string[]>(["SMEMBERS", key])) ?? [];
  return memList.get(`set:${key}`) ?? [];
}

/** Bump one field of a hash. Used to tally a payer's purchases per service. */
export async function kvHIncrBy(key: string, field: string, by = 1, ttlSeconds?: number): Promise<void> {
  if (kvConfigured()) {
    await cmd(["HINCRBY", key, field, by]);
    if (ttlSeconds) await cmd(["EXPIRE", key, ttlSeconds]);
    return;
  }
  const h = memHash.get(key) ?? new Map<string, number>();
  h.set(field, (h.get(field) ?? 0) + by);
  memHash.set(key, h);
}

/**
 * Read a whole hash as field → count. Upstash returns it as a flat
 * [field, value, field, value, …] array, not an object.
 */
export async function kvHGetAll(key: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (kvConfigured()) {
    const flat = (await cmd<string[]>(["HGETALL", key])) ?? [];
    for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = Number(flat[i + 1]) || 0;
    return out;
  }
  for (const [f, v] of memHash.get(key) ?? []) out[f] = v;
  return out;
}

/**
 * Set/refresh a TTL on an existing key. Used to keep an index from outliving the
 * records it points at. No-op on the in-memory fallback for list/set keys, which
 * only live as long as the process anyway.
 */
export async function kvExpire(key: string, ttlSeconds: number): Promise<void> {
  if (kvConfigured()) await cmd(["EXPIRE", key, ttlSeconds]);
}
