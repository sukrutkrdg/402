/**
 * Per-service usage analytics (KV-backed, durable when KV is configured).
 *
 * Logged on every served call so the private /stats dashboard can show which
 * services are called and how often (paid vs free trial).
 */

import "server-only";
import { kvIncr, kvGetNumber, kvLPush, kvLRange } from "./kv";

export async function logUsage(serviceId: string, paid: boolean): Promise<void> {
  try {
    await kvIncr(`usage:total:${serviceId}`);
    if (paid) await kvIncr(`usage:paid:${serviceId}`);
    await kvIncr("usage:calls:total"); // cheap global counter for the public strip
    await kvLPush("usage:recent", JSON.stringify({ s: serviceId, paid, t: Date.now() }), 100);
  } catch {
    /* never let analytics break a request */
  }
}

/** Single cheap read for the public "N calls served" strip (no per-service fan-out). */
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

export async function getUsage(serviceIds: string[]): Promise<{
  per: UsageRow[];
  recent: Array<{ s: string; paid: boolean; t: number }>;
  totalCalls: number;
  totalPaid: number;
}> {
  const per = await Promise.all(
    serviceIds.map(async (id) => ({
      id,
      total: await kvGetNumber(`usage:total:${id}`),
      paid: await kvGetNumber(`usage:paid:${id}`),
    })),
  );
  const recentRaw = await kvLRange("usage:recent", 0, 49);
  const recent = recentRaw
    .map((s) => {
      try {
        return JSON.parse(s) as { s: string; paid: boolean; t: number };
      } catch {
        return null;
      }
    })
    .filter((x): x is { s: string; paid: boolean; t: number } => x !== null);

  const totalCalls = per.reduce((a, r) => a + r.total, 0);
  const totalPaid = per.reduce((a, r) => a + r.paid, 0);
  return { per: per.sort((a, b) => b.total - a.total), recent, totalCalls, totalPaid };
}
