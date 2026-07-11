/**
 * Token holder distribution — top holders, concentration, and LP lock, from the
 * free GoPlus token-security data. Agents use this to gauge whale risk and how
 * fairly a token is distributed before trading.
 */

import "server-only";
import { goPlusSecurity } from "./upstream-cache";
import { getAddress } from "viem";

const isTrue = (v: unknown) => v === "1" || v === 1 || v === true;
const num = (v: unknown) => {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};
const pct = (v: unknown) => Math.round(num(v) * 100 * 100) / 100; // decimal → % (2 dp)

interface GpHolder {
  address?: string;
  tag?: string;
  is_contract?: number | string;
  is_locked?: number | string;
  percent?: string;
}
type Gp = Record<string, unknown> & { holders?: GpHolder[]; lp_holders?: GpHolder[] };

const BURN = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

export async function holderDistribution(params: Record<string, string>) {
  const raw = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… token address");
  const address = getAddress(raw);

  const gp = (await goPlusSecurity<Gp>(address)) ?? undefined;
  if (!gp || Object.keys(gp).length === 0) throw new Error("No holder data for this token");

  const holdersRaw = Array.isArray(gp.holders) ? gp.holders : [];
  const topHolders = holdersRaw.slice(0, 10).map((h) => ({
    address: h.address ?? null,
    percent: pct(h.percent),
    tag: h.tag || null,
    isContract: h.is_contract !== undefined ? isTrue(h.is_contract) : null,
    isLocked: h.is_locked !== undefined ? isTrue(h.is_locked) : null,
  }));
  const top10Pct = Math.round(topHolders.reduce((s, h) => s + h.percent, 0) * 100) / 100;

  const lpRaw = Array.isArray(gp.lp_holders) ? gp.lp_holders : [];
  const lockedLpPct = lpRaw.length
    ? Math.round(
        lpRaw.reduce(
          (s, h) =>
            s +
            (isTrue(h.is_locked) || BURN.has(String(h.address ?? "").toLowerCase())
              ? num(h.percent)
              : 0),
          0,
        ) *
          100 *
          100,
      ) / 100
    : null;

  return {
    address,
    holderCount: gp.holder_count !== undefined ? Number(gp.holder_count) : null,
    topHolders,
    top10Pct,
    topHolderPct: topHolders[0]?.percent ?? null,
    lpHolderCount: gp.lp_holder_count !== undefined ? Number(gp.lp_holder_count) : null,
    lockedLpPct,
    concentration: top10Pct >= 70 ? "high" : top10Pct >= 40 ? "medium" : "low",
    source: "GoPlus",
    checkedAt: new Date().toISOString(),
  };
}
