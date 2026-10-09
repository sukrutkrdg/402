/**
 * owner-powers — the latent rug surface. A token can look clean RIGHT NOW (low
 * tax, not a honeypot, sells fine) and still leave the owner holding the switches
 * to trap you tomorrow. sellability answers "can I sell today"; this answers the
 * harder one: "what can the owner do to me AFTER I buy?"
 *
 * Every signal is a direct GoPlus boolean, each translated into the concrete
 * attack it enables — not a flag name an agent has to look up. A token where the
 * owner can raise the sell tax to 100% (slippage_modifiable), zero your balance
 * (owner_change_balance), blacklist your address, or reclaim "renounced"
 * ownership is a honeypot-in-waiting, however benign the snapshot looks.
 *
 * Reliable (one no-key GoPlus read); heuristic in judgement, explicit about it.
 * Not financial advice.
 */

import "server-only";
import { getAddress } from "viem";
import { goPlusSecurity } from "./upstream-cache";

type Gp = Record<string, unknown> & { owner_address?: string };
const validAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test((a ?? "").trim());
const on = (v: unknown) => v === "1" || v === 1 || v === true;
const ZERO = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead", ""]);

type Sev = "critical" | "high" | "medium";
interface Power { flag: string; severity: Sev; attack: string }

// field → (severity, the concrete thing the owner can do with it)
const POWERS: Array<{ key: string; severity: Sev; attack: string }> = [
  { key: "owner_change_balance", severity: "critical", attack: "Owner can set any address's balance directly — they can zero YOUR tokens at will." },
  { key: "hidden_owner", severity: "critical", attack: "A hidden owner retains control even if ownership looks renounced — the 'renounce' is cosmetic." },
  { key: "can_take_back_ownership", severity: "high", attack: "Renounced ownership can be reclaimed — a renounce today is reversible tomorrow." },
  { key: "selfdestruct", severity: "high", attack: "The contract can self-destruct — the token (and your position) can be destroyed." },
  { key: "slippage_modifiable", severity: "high", attack: "The trading tax is mutable — the owner can raise the sell tax (to 100% = instant honeypot) after you're in." },
  { key: "personal_slippage_modifiable", severity: "high", attack: "The owner can set a PER-ADDRESS tax — they can target your wallet specifically." },
  { key: "transfer_pausable", severity: "high", attack: "Transfers can be paused — the owner can freeze all exits, including yours." },
  { key: "is_blacklisted", severity: "high", attack: "The owner can blacklist addresses — they can block YOUR address from selling." },
  { key: "cannot_sell_all", severity: "high", attack: "The contract restricts selling the full balance — you can be left holding a remainder you can't exit." },
  { key: "is_mintable", severity: "medium", attack: "Supply is mintable — the owner can inflate supply and dilute/dump on holders." },
  { key: "trading_cooldown", severity: "medium", attack: "A trading cooldown is enforced — the owner can gate the timing of your sells." },
  { key: "anti_whale_modifiable", severity: "medium", attack: "Max-transaction / anti-whale limits are mutable — they can be tightened to block sells." },
  { key: "external_call", severity: "medium", attack: "The contract makes external calls on transfer — behaviour can change through a dependency you can't see." },
  { key: "is_proxy", severity: "medium", attack: "Upgradeable proxy — the contract logic itself can be swapped for different behaviour later." },
];

export async function ownerPowers(params: Record<string, string>) {
  const raw = (params.address || params.token || "").trim();
  if (!validAddr(raw)) throw new Error("Provide a valid 0x… token address");
  const address = getAddress(raw);

  const gp = await goPlusSecurity<Gp>(address);
  if (gp === null) throw new Error("Security feed unavailable (GoPlus) — not charged, retry shortly");
  if (!gp || Object.keys(gp).length === 0) throw new Error("No security data for this token — treat as unknown, not safe");

  const found: Power[] = [];
  for (const p of POWERS) if (on(gp[p.key])) found.push({ flag: p.key, severity: p.severity, attack: p.attack });

  // Source + ownership status — the frame for the powers above.
  const isOpenSource = gp.is_open_source === undefined ? null : on(gp.is_open_source);
  if (isOpenSource === false) found.push({ flag: "not_open_source", severity: "high", attack: "Source is NOT verified — the above can't be confirmed and more may be hidden; you're trading a black box." });

  const ownerAddr = String(gp.owner_address ?? "").toLowerCase();
  const ownerRenounced = ZERO.has(ownerAddr);
  // A renounce means little if the owner can take it back or a hidden owner remains.
  const renounceReal = ownerRenounced && !on(gp.can_take_back_ownership) && !on(gp.hidden_owner);

  const critical = found.filter((f) => f.severity === "critical").length;
  const high = found.filter((f) => f.severity === "high").length;
  const medium = found.filter((f) => f.severity === "medium").length;

  let verdict: "renounced_clean" | "limited_controls" | "weaponizable" | "owner_controlled_danger";
  if (critical > 0) verdict = "owner_controlled_danger";
  else if (high >= 2) verdict = "weaponizable";
  else if (high === 1 || medium > 0) verdict = "limited_controls";
  else verdict = "renounced_clean";
  // A real renounce with no mutable powers is the clean case; otherwise the powers stand.
  if (verdict === "renounced_clean" && !renounceReal && !ownerRenounced) verdict = "limited_controls";

  const topThreats = found
    .sort((a, b) => ({ critical: 0, high: 1, medium: 2 }[a.severity] - { critical: 0, high: 1, medium: 2 }[b.severity]))
    .slice(0, 6);

  return {
    address,
    ownerAddress: gp.owner_address ?? null,
    ownershipRenounced: ownerRenounced,
    renounceIsReal: renounceReal, // false if reclaimable or a hidden owner remains
    isOpenSource,
    powerCount: found.length,
    severity: { critical, high, medium },
    powers: topThreats, // each flag + the concrete attack it enables
    verdict, // renounced_clean | limited_controls | weaponizable | owner_controlled_danger
    recommendation:
      verdict === "owner_controlled_danger"
        ? `🛑 The owner holds a CRITICAL power (${found.find((f) => f.severity === "critical")?.flag}) — ${found.find((f) => f.severity === "critical")?.attack} However clean the token looks now, the owner can trap you at will. Do not hold size.`
        : verdict === "weaponizable"
          ? `⚠️ ${high} high-severity owner powers present — this clean-looking token can be turned into a honeypot after you buy (e.g. ${topThreats[0]?.flag}). Treat any position as revocable; keep it small and exit-ready.`
          : verdict === "limited_controls"
            ? `Some mutable controls remain (${found.map((f) => f.flag).slice(0, 3).join(", ") || "owner not renounced"}). Not alarming on their own, but the owner isn't fully hands-off — know what they can still change.`
            : "Ownership is renounced with no reclaim path and no mutable trap-powers detected — the latent rug surface is minimal. (Still verify liquidity and current tax separately.)",
    note: "Enumerates the mutable owner powers that let a currently-clean token be weaponized later (GoPlus booleans, each mapped to its concrete attack). Complements sellability (today) with the latent surface (tomorrow). A signal from one feed — not proof of intent. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
