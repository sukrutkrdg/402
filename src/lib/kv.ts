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
    const j = (await res.json()) as { result?: T };
    return { ok: true, result: (j.result ?? null) as T | null };
  } catch {
    return { ok: false, result: null };
  }
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
 * Increment a counter; set TTL (seconds) when requested. Returns the new value,
 * or NULL when KV is configured but unreachable — callers guarding money or
 * quota MUST treat null as "deny" (fail closed), never as 0. A silent 0 here is
 * what previously turned every KV outage into an unlimited free tier.
 */
export async function kvIncr(key: string, ttlSeconds?: number): Promise<number | null> {
  if (kvConfigured()) {
    // Single round trip: INCR + EXPIRE pipelined. TTL is always (re)set so a key
    // never persists without expiry; daily reset comes from the date in the key.
    if (ttlSeconds) {
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
    const v = await cmdRead<string>(["GET", key]); // retry on transient failure → no false 0
    return v ? parseInt(v, 10) || 0 : 0;
  }
  const e = memValid(key);
  return e ? parseInt(e.value, 10) || 0 : 0;
}

export async function kvGet(key: string): Promise<string | null> {
  if (kvConfigured()) return await cmdRead<string>(["GET", key]);
  return memValid(key)?.value ?? null;
}

export async function kvSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  if (kvConfigured()) {
    await cmd(ttlSeconds ? ["SET", key, value, "EX", ttlSeconds] : ["SET", key, value]);
    return;
  }
  mem.set(key, { value, expireAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined });
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
  if (kvConfigured()) return (await cmdRead<string[]>(["LRANGE", key, start, stop])) ?? [];
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
  if (kvConfigured()) return (await cmdRead<string[]>(["SMEMBERS", key])) ?? [];
  return memList.get(`set:${key}`) ?? [];
}
