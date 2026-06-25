/**
 * Batch Token Risk Scan — screen up to 10 Base tokens in a single paid call.
 * Built for agents triaging a watchlist or portfolio: one x402 payment, N scores.
 */

import "server-only";
import { rugScore } from "./scores";

const MAX = 10;

export async function batchRisk(params: Record<string, string>) {
  const raw = (params.addresses || params.address || "").trim();
  const list = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) {
    throw new Error("Provide 'addresses' — comma-separated 0x… token addresses (up to 10)");
  }
  const valid = list.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  if (valid.length === 0) throw new Error("No valid 0x… addresses found");

  const capped = valid.slice(0, MAX);
  const settled = await Promise.allSettled(capped.map((a) => rugScore({ address: a })));

  const tokens = capped.map((address, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") {
      const v = r.value as { rugScore?: number; level?: string; signals?: string[] };
      return {
        address,
        rugScore: typeof v.rugScore === "number" ? v.rugScore : null,
        level: v.level ?? null,
        signals: (v.signals ?? []).slice(0, 3),
      };
    }
    return { address, error: r.reason instanceof Error ? r.reason.message.slice(0, 80) : "scan failed" };
  });

  // Sort riskiest first so the agent sees the dangerous ones up top.
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  tokens.sort((a, b) => (order[("level" in a && a.level) || "low"] ?? 3) - (order[("level" in b && b.level) || "low"] ?? 3));

  return {
    count: tokens.length,
    requested: list.length,
    truncated: valid.length > MAX,
    tokens,
    checkedAt: new Date().toISOString(),
  };
}
