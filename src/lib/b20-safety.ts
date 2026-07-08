/**
 * B20 Safety — "can this Base-native (B20) token freeze you or seize your funds?"
 *
 * B20 (Base's native precompile token standard, live 2026-07-08 18:00 UTC) adds
 * powers ERC-20 never had: an issuer can gate transfers via the Policy Registry
 * (freeze/blocklist) and, worst of all, call burnBlocked() to BURN a
 * policy-denied holder's balance outright — a protocol-level seize. This service
 * reads those powers and returns one hold/caution/avoid verdict for a B20 token.
 *
 * The RISK LOGIC below is final and ABI-independent. Only readB20Signals() —
 * the precompile reads — is pending the confirmed precompile ABIs at activation.
 */

import "server-only";

// Fixed B20 precompile addresses (same on every network).
export const B20_FACTORY = "0xB20f000000000000000000000000000000000000";
export const B20_ACTIVATION_REGISTRY = "0x8453000000000000000000000000000000000001";
export const B20_POLICY_REGISTRY = "0x8453000000000000000000000000000000000002";

export interface B20Signals {
  isB20: boolean;
  variant: "asset" | "stablecoin" | null;
  active: boolean;
  /** BURN_BLOCKED_ROLE is held → burnBlocked() can burn a denied holder's balance (seize). */
  canSeize: boolean;
  /** A transfer sender/receiver policy is set → holders can be frozen/blocklisted. */
  transferGated: boolean;
  /** initialAdmin == 0 and no admin can be re-added → immutable / governance-free. */
  adminless: boolean;
  admin: string | null;
  /** Number of addresses that can mint (dilution surface). */
  mintRoleHolders: number;
  /** PAUSE_ROLE exists → transfers can be halted. */
  pausable: boolean;
  paused: { transfer: boolean; mint: boolean; burn: boolean };
  /** Asset variant with a mutable rebase multiplier → balances can be scaled. */
  rebase: boolean;
  /** Supply cap set → mint can't exceed it. */
  supplyCapped: boolean;
}

/**
 * TODO (fill at activation, 2026-07-08 18:00 UTC, once precompile ABIs confirmed):
 *   - Activation Registry (0x8453…0001): is this address an active B20? which variant?
 *     (variant is also recoverable from address byte 10 — no RPC needed for a hint).
 *   - The B20 token: hasRole(BURN_BLOCKED_ROLE) → canSeize; hasRole(MINT_ROLE) count;
 *     hasRole(PAUSE_ROLE) → pausable; paused states for TRANSFER/MINT/BURN; admin;
 *     supply cap; (Asset) rebase multiplier / whether it's mutable.
 *   - Policy Registry (0x8453…0002): TRANSFER_SENDER/RECEIVER_POLICY set → transferGated.
 * Implement via viem eth_call against the precompiles with the confirmed ABIs.
 */
async function readB20Signals(_address: string): Promise<B20Signals> {
  throw new Error("B20 reads pending activation (precompiles go live 2026-07-08 18:00 UTC)");
}

export async function b20Safety(params: Record<string, string>) {
  const address = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Provide a valid 0x… token contract address");

  const s = await readB20Signals(address);

  if (!s.isB20) {
    return {
      address,
      isB20: false,
      note: "Not a B20 (Base-native) token — use token-risk / contract-danger for standard ERC-20 analysis.",
      checkedAt: new Date().toISOString(),
    };
  }

  // ---- Risk logic (final, ABI-independent) ----
  const flags: string[] = [];
  let risk = 0;
  const add = (n: number, why: string) => {
    risk += n;
    flags.push(why);
  };

  if (s.paused.transfer) add(35, "Transfers are CURRENTLY paused — you can't move this token right now.");
  if (s.canSeize) add(35, "Issuer can burnBlocked() — a denied holder's balance can be SEIZED (burned) at will.");
  if (s.transferGated) add(25, "Transfers are policy-gated — your address can be frozen/blocklisted.");
  if (s.pausable && !s.paused.transfer) add(12, "Transfers are pausable — the issuer can freeze trading later.");
  if (s.rebase) add(15, "Asset with a mutable rebase multiplier — your balance can be scaled up/down.");
  if (!s.supplyCapped && s.mintRoleHolders > 0) add(10, "Uncapped supply with active mint role — dilution risk.");
  if (!s.adminless && s.admin) add(8, "Has an admin — roles/policies can change under you.");

  risk = Math.min(100, risk);
  const verdict = risk >= 60 ? "avoid" : risk >= 30 ? "caution" : "hold";

  return {
    address,
    isB20: true,
    variant: s.variant,
    active: s.active,
    riskScore: risk, // 0-100, higher = more issuer control over your funds
    verdict, // hold | caution | avoid
    powers: {
      seizable: s.canSeize,
      freezable: s.transferGated || s.pausable,
      pausedNow: s.paused.transfer,
      rebase: s.rebase,
      mintable: s.mintRoleHolders > 0 && !s.supplyCapped,
      adminless: s.adminless,
    },
    flags,
    recommendation:
      verdict === "avoid"
        ? "Avoid holding size — the issuer can freeze or seize your balance at the protocol level."
        : verdict === "caution"
          ? "Usable but the issuer retains control (pause/policy/rebase). Size accordingly and re-check before large positions."
          : "No high-control powers detected — behaves close to a plain token.",
    note: "B20 is Base's native precompile token standard. Unlike ERC-20, issuers can freeze (Policy Registry) and seize (burnBlocked) at the protocol level — this checks exactly that. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
