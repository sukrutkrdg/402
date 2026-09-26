/**
 * Service health, measured from real calls — the numbers behind /status.
 *
 * Every handler run is recorded as one outcome and one latency bucket:
 *   ok     — answered
 *   input  — refused the caller's input (a 400; not our fault, not counted
 *            against success)
 *   fail   — our side failed (a 5xx: upstream down, timeout, bug)
 *
 * Cost matters (Upstash bills per command), so a call costs exactly one
 * HINCRBY on a per-day hash — field `<service>|<outcome>|<bucket>` — plus an
 * occasional EXPIRE. Reading a week back is seven HGETALLs, cached by the page.
 */

import "server-only";
import { after } from "next/server";
import { kvHIncrBy, kvHGetAll, ttlDue, kvExpire } from "./kv";
import { isRefundable } from "./envelope";

/** The HTTP status a handler error deserves: the caller's input (400), an upstream (502), or ours (500). */
export function errorStatus(message: string): 400 | 502 | 500 {
  const m = message.toLowerCase();
  // "must be", "too large/long", "choose one of", "not a" and "unsupported" are
  // the caller's input talking: retrying the same input can only fail again.
  // Word boundaries matter: "provide" must not catch "data provider unavailable"
  // (an upstream outage), and "refused:" is our own prefix for a refused trade,
  // not ECONNREFUSED.
  if (/\bprovide\b|missing|\bvalid\b|invalid|required|must be|too (large|long|many)|choose one of|unsupported|not a |no .*found|no .*data|no .*available|no price|^refused:|\bis the\b|is how many|is in basis points|same (token|asset)|evm address|not an? |^no swap:|^(from|to): |unknown order/.test(m))
    return 400;
  if (/unavailable|unreachable|failed|responded \d|timeout|fetch|rate limit|econn|enotfound|socket|retry shortly|retry in a minute|did not return|could not measure|unreadable/.test(m)) return 502;
  return 500;
}

const KEEP_DAYS = 8;
const dayKey = (d: Date) => `health:${d.toISOString().slice(0, 10)}`;

/** Latency buckets, upper bounds in ms; the last is open-ended. */
export const BUCKETS = [
  { id: "a", upto: 500, label: "<0.5s" },
  { id: "b", upto: 2000, label: "0.5–2s" },
  { id: "c", upto: 5000, label: "2–5s" },
  { id: "d", upto: 15000, label: "5–15s" },
  { id: "e", upto: Infinity, label: ">15s" },
] as const;
const bucketOf = (ms: number) => BUCKETS.find((b) => ms < b.upto)!.id;

export type Outcome = "ok" | "input" | "fail";

export async function recordOutcome(service: string, outcome: Outcome, ms: number): Promise<void> {
  const key = dayKey(new Date());
  try {
    await kvHIncrBy(key, `${service}|${outcome}|${bucketOf(ms)}`, 1);
    if (ttlDue(key, KEEP_DAYS * 86400)) await kvExpire(key, KEEP_DAYS * 86400);
  } catch {
    /* health bookkeeping never breaks a call */
  }
}

/**
 * Record after the response is sent when the runtime allows it, so a slow KV
 * never delays a paid answer; inline otherwise (tests, scripts).
 */
function recordLater(service: string, outcome: Outcome, ms: number): Promise<void> {
  try {
    after(() => recordOutcome(service, outcome, ms));
    return Promise.resolve();
  } catch {
    return recordOutcome(service, outcome, ms);
  }
}

/** Run a service handler, recording how it went. Rethrows unchanged. */
export async function timed<T>(service: string, run: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    const out = await run();
    // A refusal (core feed down, not billed) answered, but the service did not work.
    await recordLater(service, isRefundable(out) ? "fail" : "ok", Date.now() - t);
    return out;
  } catch (e) {
    const status = errorStatus(e instanceof Error ? e.message : "");
    await recordLater(service, status === 400 ? "input" : "fail", Date.now() - t);
    throw e;
  }
}

export interface ServiceHealth {
  service: string;
  calls: number;
  ok: number;
  input: number;
  fail: number;
  /** ok ÷ (ok + fail): input errors are the caller's, not ours. Null with no qualifying calls. */
  successPct: number | null;
  /** The latency bucket holding the median / 90th percentile answered call. */
  p50: string | null;
  p90: string | null;
  lastDay: { calls: number; fail: number };
}

function percentile(counts: Record<string, number>, q: number): string | null {
  const total = BUCKETS.reduce((s, b) => s + (counts[b.id] ?? 0), 0);
  if (!total) return null;
  let seen = 0;
  for (const b of BUCKETS) {
    seen += counts[b.id] ?? 0;
    if (seen >= q * total) return b.label;
  }
  return BUCKETS[BUCKETS.length - 1].label;
}

/** Per-service health over the last `days` days (today included). */
export async function readHealth(days = 7): Promise<{ from: string; to: string; services: ServiceHealth[] }> {
  const now = new Date();
  const keys = Array.from({ length: days }, (_, i) => dayKey(new Date(now.getTime() - i * 86400_000)));
  // A failed read throws rather than reading as "no calls": the page is ISR, and
  // an empty week cached for five minutes would claim every endpoint went quiet.
  const maps = await Promise.all(keys.map((k) => kvHGetAll(k)));

  const acc = new Map<string, { ok: number; input: number; fail: number; lat: Record<string, number>; day: { calls: number; fail: number } }>();
  maps.forEach((m, i) => {
    for (const [field, n] of Object.entries(m)) {
      const [svc, outcome, bucket] = field.split("|");
      if (!svc || !outcome) continue;
      const a = acc.get(svc) ?? { ok: 0, input: 0, fail: 0, lat: {}, day: { calls: 0, fail: 0 } };
      if (outcome === "ok" || outcome === "input" || outcome === "fail") a[outcome] += n;
      if (outcome === "ok" && bucket) a.lat[bucket] = (a.lat[bucket] ?? 0) + n;
      if (i <= 1) {
        // today and yesterday ≈ the last 24h without per-hour keys
        a.day.calls += n;
        if (outcome === "fail") a.day.fail += n;
      }
      acc.set(svc, a);
    }
  });

  const services = [...acc.entries()].map(([service, a]) => ({
    service,
    calls: a.ok + a.input + a.fail,
    ok: a.ok,
    input: a.input,
    fail: a.fail,
    successPct: a.ok + a.fail ? +((a.ok / (a.ok + a.fail)) * 100).toFixed(1) : null,
    p50: percentile(a.lat, 0.5),
    p90: percentile(a.lat, 0.9),
    lastDay: a.day,
  }));
  return { from: keys[keys.length - 1].slice(7), to: keys[0].slice(7), services };
}
