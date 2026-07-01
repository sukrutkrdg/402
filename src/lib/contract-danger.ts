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

// name-pattern → { category, severity, why }
const DANGER: Array<{ re: RegExp; category: string; severity: "critical" | "high" | "medium"; why: string }> = [
  { re: /^_?mint$|mintTo|mint\w*/i, category: "mint", severity: "high", why: "Owner can mint new supply (dilute holders)." },
  { re: /pause|unpause|setpaused|freeze/i, category: "pause", severity: "high", why: "Owner can pause transfers (freeze your exit)." },
  { re: /blacklist|blocklist|^ban$|setban|denylist|isbot|setbot/i, category: "blacklist", severity: "critical", why: "Owner can blacklist wallets (block YOU from selling)." },
  { re: /setfee|settax|setbuytax|setselltax|setfees|updatefee|settaxes/i, category: "tax", severity: "high", why: "Owner can change buy/sell tax after you enter." },
  { re: /setmaxtx|setmaxwallet|setmaxtransaction|setlimit|maxwallet|maxtx/i, category: "limits", severity: "medium", why: "Owner can change max tx/wallet limits (trap holders)." },
  { re: /excludefromfee|includeinfee|setexclude|setfeeexempt/i, category: "fee_exempt", severity: "medium", why: "Owner can exempt themselves from fees." },
  { re: /upgradeto|upgradetoandcall|setimplementation/i, category: "upgrade", severity: "critical", why: "Owner can swap the contract logic (upgradeable rug vector)." },
  { re: /withdraw|rescue|sweep|claimtokens|recovertoken|emergency/i, category: "withdraw", severity: "high", why: "Owner can withdraw/rescue tokens from the contract." },
  { re: /enabletrading|opentrading|settrading|starttrading|launch/i, category: "trading_switch", severity: "medium", why: "Owner controls when trading is enabled." },
  { re: /setrouter|setpair|setdex/i, category: "router", severity: "medium", why: "Owner can change the router/pair (redirect liquidity)." },
];

export async function contractDanger(params: Record<string, string>) {
  const res = (await contractAbi(params)) as {
    address?: string;
    verified?: boolean;
    functions?: string[];
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
  const dangers: Array<{ function: string; category: string; severity: string; why: string }> = [];
  const seen = new Set<string>();
  for (const fn of fns) {
    for (const d of DANGER) {
      if (d.re.test(fn)) {
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
    recommendation:
      level === "critical"
        ? "Critical owner powers present (blacklist/upgrade) — the owner can block your exit or swap the logic. Treat as high-risk unless ownership is renounced or behind a timelock."
        : level === "high"
          ? "Owner has powerful functions (mint/pause/tax/withdraw). Check whether ownership is renounced before trusting it long-term."
          : level === "medium"
            ? "Some owner controls present — review who holds ownership."
            : "No obvious dangerous owner functions found in the ABI.",
    note: "Scans the verified ABI for owner-abuse functions. Presence ≠ malicious (many are standard), but each is a power the owner COULD use. Check ownership status (renounced/timelock). Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
