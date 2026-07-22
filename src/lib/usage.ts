/**
 * Per-service usage analytics (KV-backed, durable when KV is configured).
 *
 * Logged on every served call so the private /stats dashboard can show which
 * services are called, how often, paid vs free, WHEN, and from how many distinct
 * sources (a hashed IP) — so the owner can tell their own test calls apart from
 * real external/agent traffic.
 */

import "server-only";
import { createHash } from "node:crypto";
import { kvIncr, kvGetNumber, kvGetNumberStable, kvLPush, kvLRange, kvSAdd, kvSMembers, kvPipeline, kvConfigured } from "./kv";

const day = () => new Date().toISOString().slice(0, 10);

/** Short, pseudonymous source id from an IP (so distinct callers are countable). */
export function srcHash(ip: string): string {
  return createHash("sha256").update(ip || "unknown").digest("hex").slice(0, 6);
}

/** Classify a caller from its User-Agent so owner/bot traffic is separable from real visitors. */
export function classifyUa(ua: string): "browser" | "bot" | "api" {
  const u = (ua || "").toLowerCase();
  if (!u) return "api"; // no UA → server-to-server / scripted agent
  if (/bot|crawl|spider|slurp|bing|google|yandex|baidu|duckduck|facebookexternal|preview|monitor|uptime|curl|wget|python-requests|axios|node-fetch|undici|go-http|headless|lighthouse|vercel/.test(u))
    return "bot";
  if (/mozilla|chrome|safari|firefox|edg\/|opera|mobile/.test(u)) return "browser";
  return "api";
}

/** A short, human-readable label for a User-Agent (what tool the caller used). */
export function shortUa(ua: string): string {
  const u = (ua || "").toLowerCase();
  if (!u) return "no-ua";
  if (/edg\//.test(u)) return "Edge";
  if (/chrome|crios/.test(u) && !/edg\//.test(u)) return "Chrome";
  if (/firefox|fxios/.test(u)) return "Firefox";
  if (/safari/.test(u) && !/chrome/.test(u)) return "Safari";
  if (/curl/.test(u)) return "curl";
  if (/wget/.test(u)) return "wget";
  if (/python|aiohttp|httpx/.test(u)) return "python";
  if (/axios/.test(u)) return "axios";
  if (/node-fetch|undici|bun/.test(u)) return "node";
  if (/go-http|go-resty/.test(u)) return "go";
  if (/postman|insomnia/.test(u)) return "api-tool";
  if (/bot|crawl|spider|slurp|monitor|uptime|lighthouse|preview/.test(u)) return "bot";
  if (/vercel/.test(u)) return "vercel";
  return u.slice(0, 16);
}

/** Host of the referring page, if any (where the caller came from). */
/** Sentinel referer host the hosted MCP endpoint (/api/mcp) stamps on its proxied
 * calls so usage can count the Glama-connector channel apart from direct agents. */
export const MCP_CHANNEL_HOST = "mcp.402.com.tr";

export function refHost(ref: string): string {
  if (!ref) return "";
  try {
    return new URL(ref).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export async function logUsage(
  serviceId: string,
  paid: boolean,
  source = "?",
  ua = "",
  ref = "",
  /** True for first-party calls via the internal-auth bypass (e.g. Warden) — so
   * the dashboard can tell "our own product" apart from real free-tier trials. */
  internal = false,
  /** True for a free-tier TEASER (preview) response — so we can measure how many
   * previews we serve and whether they convert to paid calls. */
  preview = false,
  /** True when the caller hit the 402 challenge and (likely) walked away — the
   * missing denominator for conversion: which services get tried but not paid. */
  challenge = false,
  /** Hashed payer wallet address on a PAID call — lets us measure repeat buyers
   * and which service a payer buys FIRST, independent of rotating IP hashes. */
  payer = "",
): Promise<void> {
  try {
    const kind = classifyUa(ua);
    const d = day();
    const entry = JSON.stringify({
      s: serviceId,
      p: paid,
      t: Date.now(),
      src: source,
      k: kind,
      ua: shortUa(ua),
      ref: refHost(ref),
      ...(internal ? { i: true } : {}),
      ...(preview ? { pv: true } : {}),
      ...(challenge ? { ch: true } : {}),
      ...(payer ? { pyr: payer } : {}),
    });
    if (kvConfigured()) {
      // One REST round trip instead of ~7 — analytics shouldn't dominate the
      // request's KV budget or latency.
      const cmds: (string | number)[][] = [
        ["INCR", `usage:total:${serviceId}`],
        ["INCR", "usage:calls:total"],
        ["INCR", `usage:day:${d}`],
        ["EXPIRE", `usage:day:${d}`, 60 * 60 * 24 * 8],
        ["SADD", `usage:src:${d}`, source],
        ["LPUSH", "usage:recent", entry],
        ["LTRIM", "usage:recent", 0, 499],
      ];
      if (paid) cmds.push(["INCR", `usage:paid:${serviceId}`], ["INCR", "usage:paid:total"], ["INCR", `usage:paidday:${d}`], ["EXPIRE", `usage:paidday:${d}`, 60 * 60 * 24 * 8]);
      if (internal) cmds.push(["INCR", `usage:internal:${serviceId}`], ["SADD", `usage:intsrc:${d}`, source]);
      if (preview) cmds.push(["INCR", `usage:preview:${serviceId}`]);
      if (kind === "bot") cmds.push(["SADD", `usage:botsrc:${d}`, source]);
      if (challenge) cmds.push(["INCR", `usage:challenge:${serviceId}`]);
      if (payer) cmds.push(["SADD", `usage:payers:${d}`, payer], ["SETNX", `usage:firstsvc:${payer}`, serviceId], ["EXPIRE", `usage:firstsvc:${payer}`, 60 * 60 * 24 * 60]);
      await kvPipeline(cmds);
      return;
    }
    await kvIncr(`usage:total:${serviceId}`);
    if (paid) {
      await kvIncr(`usage:paid:${serviceId}`);
      await kvIncr("usage:paid:total");
      await kvIncr(`usage:paidday:${d}`, 60 * 60 * 24 * 8);
    }
    if (internal) await kvIncr(`usage:internal:${serviceId}`);
    if (preview) await kvIncr(`usage:preview:${serviceId}`);
    await kvIncr("usage:calls:total");
    await kvIncr(`usage:day:${d}`, 60 * 60 * 24 * 8); // today's calls (8d ttl)
    await kvSAdd(`usage:src:${d}`, source); // distinct sources today (all)
    if (internal) await kvSAdd(`usage:intsrc:${d}`, source);
    if (kind === "bot") await kvSAdd(`usage:botsrc:${d}`, source); // bot/crawler sources today
    await kvLPush("usage:recent", entry, 100);
  } catch {
    /* never let analytics break a request */
  }
}

// These counters only ever INCREMENT, so a read that comes back lower than one
// we've already seen (typically 0, from a rate-limited KV GET that slipped past
// the retry) is provably a transient failure — never render the regression.
// Per-instance memory; resets on cold start, which is fine (the floor just
// re-learns from the next good read).
const lastGood = new Map<string, number>();
/** Clamp a monotonic counter to the highest value we've seen (never regress). */
function applyFloor(key: string, v: number): number {
  const floor = lastGood.get(key) ?? 0;
  const best = Math.max(v, floor);
  if (best > floor) lastGood.set(key, best);
  return best;
}
async function monotonicCounter(key: string): Promise<number> {
  let v = 0;
  try {
    v = await kvGetNumberStable(key); // retrying read — only the hot singleton counters
  } catch {
    v = 0;
  }
  return applyFloor(key, v);
}

/** Single cheap read for the public "N calls served" strip. */
export async function getCallsServed(): Promise<number> {
  return monotonicCounter("usage:calls:total");
}

/** Public social-proof counter: total PAID calls (real agents that paid). */
export async function getPaidServed(): Promise<number> {
  return monotonicCounter("usage:paid:total");
}

export interface UsageRow {
  id: string;
  total: number;
  paid: number;
  internal: number;
  preview: number;
  challenge: number;
}
export interface RecentCall {
  s: string;
  p: boolean;
  t: number;
  src: string;
  k?: "browser" | "bot" | "api";
  ua?: string;
  ref?: string;
  /** First-party internal-auth call (not a real visitor, not a paid buyer). */
  i?: boolean;
  /** Free-tier teaser (preview) response. */
  pv?: boolean;
  /** Hit the 402 price challenge and (likely) walked away. */
  ch?: boolean;
  /** Hashed payer wallet on a paid call. */
  pyr?: string;
}

export async function getUsage(serviceIds: string[], ownerSources: string[] = []): Promise<{
  per: UsageRow[];
  recent: RecentCall[];
  totalCalls: number;
  totalPaid: number;
  perTotalCalls: number;
  paidToday: number;
  today: number;
  sourcesToday: number;
  botSourcesToday: number;
  internalSourcesToday: number;
  externalSourcesToday: number;
  payersToday: number;
  degraded: boolean;
  channels: {
    sample: number;
    viaMcp: number;
    viaMcpPaid: number;
    clients: { browser: number; bot: number; api: number };
    referers: { host: string; count: number }[];
    noReferer: number;
  };
}> {
  const d = day();
  // Per-service counters, read in parallel (the proven path). Each kvGetNumber
  // now retries a transient failure internally, so a rate-limited read recovers
  // instead of returning a false 0 — no giant single pipeline (which risked the
  // whole read, incl. the recent-activity feed, failing at once).
  const per = await Promise.all(
    serviceIds.map(async (id) => ({
      id,
      total: await kvGetNumber(`usage:total:${id}`),
      paid: await kvGetNumber(`usage:paid:${id}`),
      internal: await kvGetNumber(`usage:internal:${id}`),
      preview: await kvGetNumber(`usage:preview:${id}`),
      challenge: await kvGetNumber(`usage:challenge:${id}`),
    })),
  );
  // Read a wider window (up to the 500-entry cap) for channel/referer breakdowns;
  // the UI activity feed still shows just the newest 30.
  const recentAll = (await kvLRange("usage:recent", 0, 499))
    .map((s) => { try { return JSON.parse(s) as RecentCall; } catch { return null; } })
    .filter((x): x is RecentCall => x !== null);
  const recent = recentAll.slice(0, 30);

  // Channel breakdown. NOTE: direct agent/x402 calls carry no Referer (only the
  // hosted MCP proxy tags itself via MCP_CHANNEL_HOST), so `referers` mostly
  // reflects web + MCP, not upstream discovery. `viaMcp` and `clients` are the
  // reliable signals — how much flows through the hosted MCP, and the browser/
  // bot/api mix.
  const refTally = new Map<string, number>();
  const clients = { browser: 0, bot: 0, api: 0 };
  let viaMcp = 0;
  let viaMcpPaid = 0;
  let noReferer = 0;
  for (const r of recentAll) {
    const host = (r.ref || "").trim();
    if (host) refTally.set(host, (refTally.get(host) ?? 0) + 1);
    else noReferer++;
    if (host === MCP_CHANNEL_HOST) { viaMcp++; if (r.p) viaMcpPaid++; }
    if (r.k) clients[r.k]++;
  }
  const channels = {
    sample: recentAll.length,
    viaMcp, // calls that came through the hosted MCP endpoint (Glama-connector channel)
    viaMcpPaid,
    clients, // browser / bot / api mix
    referers: [...refTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([host, count]) => ({ host, count })),
    noReferer,
  };

  const perTotalCalls = per.reduce((a, r) => a + r.total, 0); // current-services sum (≤ total)
  // Global counters (same never-regress floor as the public strip) so /stats and
  // the landing page always agree.
  const [totalCalls, totalPaid, today, paidToday, all, botArr, intArr, payerArr] = await Promise.all([
    monotonicCounter("usage:calls:total"),
    monotonicCounter("usage:paid:total"),
    kvGetNumber(`usage:day:${d}`),
    kvGetNumber(`usage:paidday:${d}`),
    kvSMembers(`usage:src:${d}`),
    kvSMembers(`usage:botsrc:${d}`),
    kvSMembers(`usage:intsrc:${d}`),
    kvSMembers(`usage:payers:${d}`),
  ]);
  const bots = new Set(botArr);
  const internals = new Set(intArr);
  const owner = new Set(ownerSources);
  // Heuristic: a positive per-service sum but a zero global counter means the
  // global read hiccuped this call — flag degraded so the UI keeps its last good
  // snapshot instead of flashing 0.
  const degraded = totalCalls === 0 && perTotalCalls > 0;

  return {
    per: per.filter((r) => r.total > 0).sort((a, b) => b.total - a.total),
    recent,
    totalCalls: degraded ? perTotalCalls : totalCalls,
    totalPaid,
    perTotalCalls,
    paidToday,
    today,
    sourcesToday: all.length,
    botSourcesToday: bots.size,
    internalSourcesToday: internals.size,
    // Real external visitors = distinct sources today minus bots, minus the
    // owner's own devices, minus our own first-party services.
    externalSourcesToday: all.filter((s) => !bots.has(s) && !owner.has(s) && !internals.has(s)).length,
    payersToday: payerArr.length,
    degraded,
    channels,
  };
}
