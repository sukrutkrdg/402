/**
 * LP Lock Details — "is the liquidity locked, how much, and until when?"
 *
 * Unlocked liquidity is the single clearest rug setup: the deployer can pull the
 * pool at any time. This surfaces the LP holders, how much of the LP supply is
 * locked or burned, the lockers, and unlock dates — the detail a one-line
 * "LP locked: yes/no" hides.
 *
 * Free upstream (GoPlus) → stays in the standard tier.
 */

import "server-only";
import { goPlusSecurity } from "./upstream-cache";
import { getAddress } from "viem";

interface LockDetail {
  amount?: string;
  end_time?: string;
  opt_time?: string;
}
interface LpHolder {
  address?: string;
  tag?: string;
  is_locked?: number | boolean;
  locked_detail?: LockDetail[];
  percent?: string | number;
  balance?: string;
}

const BURN = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

function reqAddr(raw: string): string {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… token address");
  return getAddress(v);
}
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const isTrue = (v: unknown) => v === 1 || v === "1" || v === true;

export async function lpLock(params: Record<string, string>) {
  const address = reqAddr(params.address || "");

  const gp = (await goPlusSecurity<{ lp_holders?: LpHolder[]; lp_total_supply?: string; holder_count?: string | number }>(address)) ?? undefined;
  if (!gp) throw new Error("No LP data for this token");

  const lps = Array.isArray(gp.lp_holders) ? gp.lp_holders : [];
  if (lps.length === 0) throw new Error("No LP holders found (token may have no DEX pool)");

  let lockedPct = 0;
  let burnedPct = 0;
  const lockers: Array<{ address: string | null; tag: string | null; percent: number; unlockDate: string | null }> = [];

  for (const h of lps) {
    const addr = (h.address ?? "").toLowerCase();
    const pct = num(h.percent) * 100;
    const burned = BURN.has(addr);
    const locked = isTrue(h.is_locked) || (h.locked_detail && h.locked_detail.length > 0);
    if (burned) {
      burnedPct += pct;
    } else if (locked) {
      lockedPct += pct;
      // end_time is a unix seconds number in most responses, but GoPlus also
      // returns a "YYYY-MM-DD HH:MM:SS" string for some pools — Number() on that
      // is NaN and new Date(NaN).toISOString() THROWS, 500-ing the whole call.
      const end = h.locked_detail?.[0]?.end_time;
      let unlockDate: string | null = null;
      if (end !== undefined && end !== null && end !== "") {
        const secs = Number(end);
        const d = Number.isFinite(secs) ? new Date(secs * 1000) : new Date(String(end));
        unlockDate = Number.isNaN(d.getTime()) ? null : d.toISOString();
      }
      lockers.push({ address: h.address ?? null, tag: h.tag || null, percent: +pct.toFixed(2), unlockDate });
    }
  }

  const securedPct = +(lockedPct + burnedPct).toFixed(2); // locked + burned = can't be pulled
  const unlockedPct = +Math.max(0, 100 - securedPct).toFixed(2);
  const holderCount = gp.holder_count !== undefined ? Number(gp.holder_count) : null;

  // Established tokens (very high holder count) usually run protocol-owned
  // liquidity that isn't in a traditional locker — "unlocked" there is not the
  // rug setup it is on a fresh launch. Soften the verdict + say so.
  const established = holderCount !== null && holderCount >= 50000;

  let level = securedPct >= 95 ? "low" : securedPct >= 50 ? "medium" : "high";
  if (level === "high" && established) level = "medium";

  return {
    address,
    holderCount,
    lpSecuredPercent: securedPct, // locked + burned
    lpLockedPercent: +lockedPct.toFixed(2),
    lpBurnedPercent: +burnedPct.toFixed(2),
    lpUnlockedPercent: unlockedPct, // can be pulled by whoever holds it
    lockers, // each locker with unlock date
    likelyProtocolOwned: established && securedPct < 50, // established token, LP not in a locker → probably protocol-owned
    rugRisk: level, // low (secured) | medium | high (mostly unlocked)
    recommendation:
      established && securedPct < 50
        ? `${unlockedPct}% of LP isn't in a traditional lock, but this is an established token (${holderCount?.toLocaleString()} holders) — the liquidity is likely protocol-owned, not a fresh-launch rug setup. Verify for large positions.`
        : level === "high"
          ? `${unlockedPct}% of LP is unlocked — the holder can pull liquidity at any time. High rug setup.`
          : level === "medium"
            ? `${securedPct}% of LP is secured; ${unlockedPct}% is still pullable. Partial protection.`
            : `${securedPct}% of LP is locked or burned — liquidity can't be easily pulled.`,
    note: "Locked + burned LP can't be rug-pulled; unlocked LP can. On fresh launches this is the key rug signal; on established tokens unlocked LP is usually protocol-owned. Check unlock dates. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
