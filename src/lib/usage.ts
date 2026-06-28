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
import { kvIncr, kvGetNumber, kvLPush, kvLRange, kvSAdd, kvSMembers } from "./kv";

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

export async function logUsage(serviceId: string, paid: boolean, source = "?", ua = ""): Promise<void> {
  try {
    const kind = classifyUa(ua);
    await kvIncr(`usage:total:${serviceId}`);
    if (paid) await kvIncr(`usage:paid:${serviceId}`);
    await kvIncr("usage:calls:total");
    await kvIncr(`usage:day:${day()}`, 60 * 60 * 24 * 8); // today's calls (8d ttl)
    await kvSAdd(`usage:src:${day()}`, source); // distinct sources today (all)
    if (kind === "bot") await kvSAdd(`usage:botsrc:${day()}`, source); // bot/crawler sources today
    await kvLPush(
      "usage:recent",
      JSON.stringify({ s: serviceId, p: paid, t: Date.now(), src: source, k: kind }),
      100,
    );
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
}
export interface RecentCall {
  s: string;
  p: boolean;
  t: number;
  src: string;
  k?: "browser" | "bot" | "api";
}

export async function getUsage(serviceIds: string[], ownerSources: string[] = []): Promise<{
  per: UsageRow[];
  recent: RecentCall[];
  totalCalls: number;
  totalPaid: number;
  today: number;
  sourcesToday: number;
  botSourcesToday: number;
  externalSourcesToday: number;
}> {
  const per = await Promise.all(
    serviceIds.map(async (id) => ({
      id,
      total: await kvGetNumber(`usage:total:${id}`),
      paid: await kvGetNumber(`usage:paid:${id}`),
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
  let sourcesToday = 0;
  let botSourcesToday = 0;
  let externalSourcesToday = 0;
  try {
    today = await kvGetNumber(`usage:day:${day()}`);
    const all = await kvSMembers(`usage:src:${day()}`);
    const bots = new Set(await kvSMembers(`usage:botsrc:${day()}`));
    const owner = new Set(ownerSources);
    sourcesToday = all.length;
    botSourcesToday = bots.size;
    // Real external visitors = distinct sources today minus bots minus the owner's own.
    externalSourcesToday = all.filter((s) => !bots.has(s) && !owner.has(s)).length;
  } catch {
    /* ignore */
  }

  return {
    per: per.filter((r) => r.total > 0).sort((a, b) => b.total - a.total),
    recent,
    totalCalls,
    totalPaid,
    today,
    sourcesToday,
    botSourcesToday,
    externalSourcesToday,
  };
}
