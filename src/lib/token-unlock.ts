/**
 * Token Unlock Calendar — "when does locked liquidity unlock, and is a cliff
 * coming?"
 *
 * Upcoming LP unlocks are scheduled price events: the moment a lock expires, the
 * holder can pull liquidity. This turns raw lock data into a forward calendar —
 * each unlock with its date, the % of LP it frees, the locker, and how many days
 * away — and flags imminent unlocks (<30 days) that a position should watch.
 * Free upstream (GoPlus, via lp-lock).
 */

import "server-only";
import { lpLock } from "./lp-lock";

interface Locker {
  address?: string | null;
  tag?: string | null;
  percent?: number;
  unlockDate?: string | null;
}
interface LpShape {
  lpSecuredPercent?: number;
  lpLockedPercent?: number;
  lpUnlockedPercent?: number;
  lockers?: Locker[];
  likelyProtocolOwned?: boolean;
}

// Known locker address → label (lowercase). GoPlus usually supplies a `tag`, but
// label the common lockers ourselves when it doesn't.
const KNOWN_LOCKERS: Record<string, string> = {
  "0x71b5759d73262fbb223956913ecf4ecc51057641": "UNCX",
  "0xe2fe530c047f2d85298b07d9333c05737f1435fb": "Team Finance",
};

export async function tokenUnlock(params: Record<string, string>) {
  const address = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Provide a valid 0x… token contract address");

  // lpLock throws (pre-settlement) if there's no LP data — buyer isn't charged.
  const lp = (await lpLock({ address })) as LpShape;
  const lockers = lp.lockers ?? [];
  const now = Date.now();

  const unlocks = lockers
    .filter((l) => l.unlockDate) // only entries with a real unlock timestamp
    .map((l) => {
      const t = new Date(l.unlockDate as string).getTime();
      const daysUntil = Math.round((t - now) / 86400000);
      const lockerAddr = (l.address ?? "").toLowerCase();
      return {
        unlockDate: l.unlockDate as string,
        daysUntil,
        percentOfLp: typeof l.percent === "number" ? +l.percent.toFixed(2) : null,
        locker: l.address ?? null,
        lockerLabel: l.tag || KNOWN_LOCKERS[lockerAddr] || null,
        status: daysUntil <= 0 ? "unlocked" : daysUntil <= 30 ? "imminent" : "locked",
      };
    })
    .sort((a, b) => a.daysUntil - b.daysUntil);

  const upcoming = unlocks.filter((u) => u.daysUntil > 0);
  const nextUnlock = upcoming[0] ?? null;
  const hasImminentUnlock = upcoming.some((u) => u.daysUntil <= 30);
  const imminentPct = +upcoming
    .filter((u) => u.daysUntil <= 30)
    .reduce((s, u) => s + (u.percentOfLp ?? 0), 0)
    .toFixed(2);

  return {
    address,
    lpSecuredPercent: lp.lpSecuredPercent ?? null,
    lpUnlockedPercent: lp.lpUnlockedPercent ?? null,
    likelyProtocolOwned: lp.likelyProtocolOwned ?? false,
    unlockCount: unlocks.length,
    hasImminentUnlock, // any lock expiring within 30 days
    imminentUnlockPct: imminentPct, // % of LP freed within 30 days
    nextUnlock, // soonest upcoming unlock (null if none scheduled)
    unlocks, // full forward calendar, soonest first
    recommendation:
      hasImminentUnlock
        ? `${imminentPct}% of LP unlocks within 30 days${nextUnlock ? ` (next in ${nextUnlock.daysUntil}d)` : ""} — a liquidity pull becomes possible then. Watch closely or size down.`
        : upcoming.length > 0
          ? `Next LP unlock is ${nextUnlock?.daysUntil} days out — no imminent cliff.`
          : lp.likelyProtocolOwned
            ? "No traditional locks with unlock dates — liquidity is likely protocol-owned."
            : "No scheduled LP unlocks found (LP may be burned, unlocked, or without dated locks).",
    note: "Unlock dates come from on-chain lock records. A near-term unlock is when a rug becomes possible, not certain. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
