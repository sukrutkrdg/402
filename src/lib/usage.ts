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
import { kvIncr, kvGetNumber, kvLPush, kvLRange, kvSAdd, kvSMembers, kvPipeline, kvConfigured } from "./kv";

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
        ["LTRIM", "usage:recent", 0, 99],
      ];
      if (paid) cmds.push(["INCR", `usage:paid:${serviceId}`], ["INCR", `usage:paidday:${d}`], ["EXPIRE", `usage:paidday:${d}`, 60 * 60 * 24 * 8]);
      if (internal) cmds.push(["INCR", `usage:internal:${serviceId}`], ["SADD", `usage:intsrc:${d}`, source]);
      if (preview) cmds.push(["INCR", `usage:preview:${serviceId}`]);
      if (kind === "bot") cmds.push(["SADD", `usage:botsrc:${d}`, source]);
      await kvPipeline(cmds);
      return;
    }
    await kvIncr(`usage:total:${serviceId}`);
    if (paid) {
      await kvIncr(`usage:paid:${serviceId}`);
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

/** Single cheap read for the public "N calls served" strip. */
export async function getCallsServed(): Promise<number> {
  try {
    return await kvGetNumber("usage:calls:total");
  } catch {
    return 0;
  }
}

export interface UsageRow {
  id: string;
  total: number;
  paid: number;
  internal: number;
  preview: number;
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
}

export async function getUsage(serviceIds: string[], ownerSources: string[] = []): Promise<{
  per: UsageRow[];
  recent: RecentCall[];
  totalCalls: number;
  totalPaid: number;
  paidToday: number;
  today: number;
  sourcesToday: number;
  botSourcesToday: number;
  internalSourcesToday: number;
  externalSourcesToday: number;
}> {
  const per = await Promise.all(
    serviceIds.map(async (id) => ({
      id,
      total: await kvGetNumber(`usage:total:${id}`),
      paid: await kvGetNumber(`usage:paid:${id}`),
      internal: await kvGetNumber(`usage:internal:${id}`),
      preview: await kvGetNumber(`usage:preview:${id}`),
    })),
  );
  const recentRaw = await kvLRange("usage:recent", 0, 29);
  const recent = recentRaw
    .map((s) => {
      try {
        return JSON.parse(s) as RecentCall;
      } catch {
        return null;
      }
    })
    .filter((x): x is RecentCall => x !== null);

  const totalCalls = per.reduce((a, r) => a + r.total, 0);
  const totalPaid = per.reduce((a, r) => a + r.paid, 0);
  let today = 0;
  let paidToday = 0;
  let sourcesToday = 0;
  let botSourcesToday = 0;
  let internalSourcesToday = 0;
  let externalSourcesToday = 0;
  try {
    today = await kvGetNumber(`usage:day:${day()}`);
    paidToday = await kvGetNumber(`usage:paidday:${day()}`);
    const all = await kvSMembers(`usage:src:${day()}`);
    const bots = new Set(await kvSMembers(`usage:botsrc:${day()}`));
    const internals = new Set(await kvSMembers(`usage:intsrc:${day()}`));
    const owner = new Set(ownerSources);
    sourcesToday = all.length;
    botSourcesToday = bots.size;
    internalSourcesToday = internals.size;
    // Real external visitors = distinct sources today minus bots, minus the
    // owner's own devices, minus our own first-party services.
    externalSourcesToday = all.filter((s) => !bots.has(s) && !owner.has(s) && !internals.has(s)).length;
  } catch {
    /* ignore */
  }

  return {
    per: per.filter((r) => r.total > 0).sort((a, b) => b.total - a.total),
    recent,
    totalCalls,
    totalPaid,
    paidToday,
    today,
    sourcesToday,
    botSourcesToday,
    internalSourcesToday,
    externalSourcesToday,
  };
}
