/**
 * Contract Danger Scanner — "what can the owner do to you?"
 *
 * Reads a verified contract's ABI and flags the owner-callable functions that
 * are abuse vectors: mint (supply inflation), pause (freeze your exit),
 * blacklist (block your wallet), setFee/setTax (tax you after entry), withdraw/
 * sweep (pull funds), upgrade (swap the logic). An unverified contract is itself
 * a red flag (you can't see what it can do). This is diligence you can't get
 * from a price feed.
 *
 * Free upstream (Sourcify) → stays in the standard tier.
 */

import "server-only";
import { contractAbi } from "./onchain-extra3";

/**
 * name-pattern → { category, severity, why }
 *
 * Two things this scanner used to get wrong, both of which turned an ordinary
 * contract into a scary verdict:
 *
 * 1. It matched names anywhere in the string, so `maxWallet()`, `paused()`,
 *    `launchTime()`, `isBot(address)` and OpenZeppelin's `MINTER_ROLE()` all
 *    tripped it — every one of them a read. Reads are now filtered out before
 *    matching (see `writeFunctions`), and the patterns below are anchored to the
 *    start of the name, because Solidity verbs lead: `setFee`, `mintTo`,
 *    `enableTrading`.
 *
 * 2. Every `why` asserted "Owner can …". An ABI does not say who may call a
 *    function — `withdraw()` on a staking contract is how you get YOUR money
 *    out, and it read identically to an owner drain. The wording now states
 *    what was actually read and names the condition, which is also what makes
 *    the answer usable: the caller knows what to go check.
 */
/**
 * True when `name` begins with `verb` as a WHOLE camelCase token.
 *
 * The boundary is the entire point. `mint` must catch `mint`, `mintTo`,
 * `mint_to` and `_mint`, and must not catch `minter`, `minting` or
 * `mintingFinished`; `pause` must not catch `pausable`. A regex cannot express
 * this with the /i flag, which was the bug: under case-insensitive matching
 * `[A-Z]` also matches lowercase, so every "verb followed by a boundary"
 * pattern silently degraded to a bare prefix match.
 */
function startsWithVerb(name: string, verb: string): boolean {
  const n = name.replace(/^_+/, "");
  if (n.length < verb.length) return false;
  if (n.slice(0, verb.length).toLowerCase() !== verb) return false;
  const next = n[verb.length];
  // End of the name, or the start of a new token (`To`, `_to`, `2`).
  return next === undefined || !/[a-z]/.test(next);
}

const DANGER: Array<{ verbs: string[]; category: string; severity: "critical" | "high" | "medium"; why: string }> = [
  { verbs: ["mint"], category: "mint", severity: "high", why: "Mints new supply. If access is restricted to the owner, they can dilute holders at will." },
  { verbs: ["pause", "unpause", "setpaused", "freeze", "unfreeze"], category: "pause", severity: "high", why: "Pauses or freezes contract activity. If owner-restricted, they can freeze your exit." },
  { verbs: ["blacklist", "blocklist", "denylist", "setblacklist", "addblacklist", "removeblacklist", "setban", "ban", "setbot", "setbots"], category: "blacklist", severity: "critical", why: "Marks addresses on a deny list. If owner-restricted, they can block YOU from selling." },
  { verbs: ["setfee", "setfees", "settax", "settaxes", "setbuytax", "setselltax", "setbuyfee", "setsellfee", "updatefee", "updatefees", "updatetax"], category: "tax", severity: "high", why: "Changes the buy/sell fee. If owner-restricted, the tax can move after you enter." },
  { verbs: ["setmaxtx", "setmaxwallet", "setmaxtransaction", "setmaxtxamount", "setlimit", "setlimits", "settransactionlimit"], category: "limits", severity: "medium", why: "Changes max tx/wallet limits. If owner-restricted, holders can be trapped by a lowered cap." },
  { verbs: ["excludefromfee", "excludefromfees", "includeinfee", "includeinfees", "setexclude", "setfeeexempt"], category: "fee_exempt", severity: "medium", why: "Exempts addresses from fees. If owner-restricted, they can exempt themselves." },
  { verbs: ["upgradeto", "upgradetoandcall", "setimplementation", "authorizeupgrade", "upgrade"], category: "upgrade", severity: "critical", why: "Replaces the contract logic. If owner-restricted, every other guarantee here can be rewritten." },
  { verbs: ["withdraw", "rescue", "sweep", "claimtokens", "recovertoken", "recovertokens", "emergencywithdraw"], category: "withdraw", severity: "high", why: "Moves tokens out of the contract. Often the legitimate way holders withdraw their own funds — check whether this one is owner-only." },
  // `launch` alone is dropped on purpose: `launchTime` is a timestamp and
  // `launchToken` is an action, and the name cannot tell you which.
  { verbs: ["enabletrading", "opentrading", "settrading", "starttrading", "launchtrading", "launchtoken"], category: "trading_switch", severity: "medium", why: "Controls whether trading is on. If owner-restricted, they choose when you may sell." },
  { verbs: ["setrouter", "setpair", "setdex", "setswaprouter"], category: "router", severity: "medium", why: "Changes the router/pair. If owner-restricted, liquidity can be redirected." },
];

export async function contractDanger(params: Record<string, string>) {
  const res = (await contractAbi(params)) as {
    address?: string;
    verified?: boolean;
    functions?: string[];
    writeFunctions?: string[];
    abiItemCount?: number;
  };
  const address = res.address ?? params.address;

  if (res.verified === false) {
    return {
      address,
      verified: false,
      dangerLevel: "high",
      dangers: [],
      note: "Contract source is NOT verified on Sourcify — you cannot inspect what its owner can do. Unverified contracts are a red flag on their own.",
      checkedAt: new Date().toISOString(),
    };
  }

  const fns = res.functions ?? [];
  // Only functions that can change state. A `view` cannot do anything to you
  // however it is named, and treating reads as powers was this scanner's single
  // biggest source of false alarms.
  const writes = res.writeFunctions ?? fns;
  const dangers: Array<{ function: string; category: string; severity: string; why: string }> = [];
  const seen = new Set<string>();
  for (const fn of writes) {
    for (const d of DANGER) {
      if (d.verbs.some((v) => startsWithVerb(fn, v))) {
        const key = `${fn}:${d.category}`;
        if (!seen.has(key)) {
          seen.add(key);
          dangers.push({ function: fn, category: d.category, severity: d.severity, why: d.why });
        }
      }
    }
  }

  const hasCritical = dangers.some((d) => d.severity === "critical");
  const hasHigh = dangers.some((d) => d.severity === "high");
  const level = hasCritical ? "critical" : hasHigh ? "high" : dangers.length > 0 ? "medium" : "low";

  // De-dup category summary.
  const categories = [...new Set(dangers.map((d) => d.category))];

  return {
    address,
    verified: true,
    dangerLevel: level, // low | medium | high | critical
    dangerCategories: categories, // e.g. ["blacklist","mint","tax"]
    dangerCount: dangers.length,
    dangers, // each: function, category, severity, why
    functionCount: fns.length,
    writeFunctionCount: writes.length,
    // Stated plainly because it bounds every verdict above: an ABI lists what
    // exists, never who may call it. We cannot see modifiers, roles or whether
    // ownership is renounced, so none of this is evidence that an owner HAS
    // these powers — only that the functions are there to be restricted.
    accessControlVisible: false,
    recommendation:
      level === "critical"
        ? "Critical-capability functions present (deny-list / upgrade). If they are owner-restricted, the owner can block your exit or replace the logic — confirm ownership is renounced or behind a timelock before treating this as safe."
        : level === "high"
          ? "Powerful functions present (mint/pause/tax/withdraw). Check who can call them and whether ownership is renounced before trusting this long-term."
          : level === "medium"
            ? "Some control functions present — check who holds ownership."
            : "No state-changing functions matching the known owner-abuse patterns.",
    note: "Scans the verified ABI's state-changing functions for owner-abuse patterns; read-only functions are excluded because they cannot act on you. Presence is not malice — most of these are standard — and the ABI does not reveal access control, so treat each as a power that MIGHT be owner-restricted and verify ownership status (renounced/timelock). Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
