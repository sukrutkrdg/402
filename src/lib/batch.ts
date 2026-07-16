/**
 * Batch Token Risk Scan — screen up to 10 Base tokens in a single paid call.
 * Built for agents triaging a watchlist or portfolio: one x402 payment, N scores.
 */

import "server-only";
import { rugScore } from "./scores";
import { riskSignal, severityRank, finish } from "./envelope";

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
      const sig = riskSignal(r.value);
      const signals = (r.value as { signals?: string[] }).signals ?? [];
      return {
        address,
        rugScore: sig.score,
        level: sig.level, // low | medium | high | unknown
        signals: signals.slice(0, 3),
      };
    }
    return { address, error: r.reason instanceof Error ? r.reason.message.slice(0, 80) : "scan failed" };
  });

  // Sort riskiest first (unknown ranks just under high — an unassessed token
  // isn't safe) so the agent sees what matters up top.
  tokens.sort((a, b) => severityRank("level" in a ? a.level : undefined) - severityRank("level" in b ? b.level : undefined));

  return finish({
    count: tokens.length,
    requested: list.length,
    truncated: valid.length > MAX,
    tokens,
  });
}
