/**
 * B20 Safety — "can this Base-native (B20) token freeze you or seize your funds?"
 *
 * B20 (Base's native precompile token standard, live 2026-07-08) adds powers
 * ERC-20 never had: an issuer can gate transfers via a Policy Registry blocklist
 * and call burnBlocked() to BURN a blocked holder's balance — a protocol-level
 * seize. This reads those powers straight from the token precompile and returns
 * one hold/caution/avoid verdict.
 *
 * Key insight from the spec (IB20): burnBlocked only affects an address that is
 * NOT authorized under TRANSFER_SENDER_POLICY. So the seize/freeze surface is
 * exactly whether the token has a sender/receiver policy set — which we can read
 * via policyId(scope). No role enumeration needed.
 */

import "server-only";
import { createPublicClient, http, getAddress, keccak256, toBytes } from "viem";
import { base } from "viem/chains";

// Fixed B20 precompile addresses (same on every network).
export const B20_FACTORY = "0xB20f000000000000000000000000000000000000";
export const B20_ACTIVATION_REGISTRY = "0x8453000000000000000000000000000000000001";
export const B20_POLICY_REGISTRY = "0x8453000000000000000000000000000000000002";

const client = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL || undefined),
});

// Minimal IB20 view surface we need.
const B20_ABI = [
  { type: "function", name: "supplyCap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isPaused", stateMutability: "view", inputs: [{ type: "uint8" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "policyId", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "multiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

// Policy scope ids are keccak256 of the label (per B20Constants).
const TRANSFER_SENDER_POLICY = keccak256(toBytes("TRANSFER_SENDER_POLICY"));
const TRANSFER_RECEIVER_POLICY = keccak256(toBytes("TRANSFER_RECEIVER_POLICY"));
// PausableFeature enum: TRANSFER=0, MINT=1, BURN=2.
const MAX_SUPPLY_CAP = (1n << 128n) - 1n; // uint128.max == "no cap" sentinel

export interface B20Signals {
  isB20: boolean;
  variant: "asset" | "stablecoin" | null;
  symbol: string | null;
  /** A transfer-sender policy is set → holders can be blocklisted AND burnBlocked (seized). */
  canSeize: boolean;
  /** A sender or receiver policy is set → holders can be frozen/blocklisted. */
  transferGated: boolean;
  paused: { transfer: boolean; mint: boolean; burn: boolean };
  /** Asset variant → has a mutable rebase multiplier that can scale balances. */
  rebase: boolean;
  /** Supply cap set (not the uint128.max "no cap" sentinel). */
  supplyCapped: boolean;
}

async function readB20Signals(address: string): Promise<B20Signals> {
  const addr = getAddress(address);
  const empty: B20Signals = {
    isB20: false,
    variant: null,
    symbol: null,
    canSeize: false,
    transferGated: false,
    paused: { transfer: false, mint: false, burn: false },
    rebase: false,
    supplyCapped: false,
  };

  // supplyCap() exists on every B20 and reverts on a plain ERC-20 → B20 probe.
  let supplyCap: bigint;
  try {
    supplyCap = (await client.readContract({ address: addr, abi: B20_ABI, functionName: "supplyCap" })) as bigint;
  } catch {
    return empty; // not a B20 token
  }

  // Asset variant exposes multiplier(); Stablecoin doesn't.
  let variant: "asset" | "stablecoin" = "stablecoin";
  try {
    await client.readContract({ address: addr, abi: B20_ABI, functionName: "multiplier" });
    variant = "asset";
  } catch {
    /* stablecoin */
  }

  const [senderPol, recvPol, pT, pM, pB, symbol] = await Promise.all([
    client.readContract({ address: addr, abi: B20_ABI, functionName: "policyId", args: [TRANSFER_SENDER_POLICY] }) as Promise<bigint>,
    client.readContract({ address: addr, abi: B20_ABI, functionName: "policyId", args: [TRANSFER_RECEIVER_POLICY] }) as Promise<bigint>,
    client.readContract({ address: addr, abi: B20_ABI, functionName: "isPaused", args: [0] }) as Promise<boolean>,
    client.readContract({ address: addr, abi: B20_ABI, functionName: "isPaused", args: [1] }) as Promise<boolean>,
    client.readContract({ address: addr, abi: B20_ABI, functionName: "isPaused", args: [2] }) as Promise<boolean>,
    client.readContract({ address: addr, abi: B20_ABI, functionName: "symbol" }).catch(() => null) as Promise<string | null>,
  ]);

  return {
    isB20: true,
    variant,
    symbol,
    canSeize: senderPol > 0n,
    transferGated: senderPol > 0n || recvPol > 0n,
    paused: { transfer: pT, mint: pM, burn: pB },
    rebase: variant === "asset",
    supplyCapped: supplyCap !== MAX_SUPPLY_CAP,
  };
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

  // ---- Risk logic (only signals we can actually read) ----
  const flags: string[] = [];
  let risk = 0;
  const add = (n: number, why: string) => {
    risk += n;
    flags.push(why);
  };

  if (s.paused.transfer) add(35, "Transfers are CURRENTLY paused — you can't move this token right now.");
  if (s.canSeize) add(35, "Sender blocklist policy is set — the issuer can block you and burnBlocked() (SEIZE) your balance.");
  if (s.transferGated) add(25, "Transfers are policy-gated — your address can be frozen/blocklisted.");
  if (s.rebase) add(15, "Asset variant with a mutable rebase multiplier — your balance can be scaled up/down.");
  if (!s.supplyCapped) add(10, "No supply cap — mintable without ceiling (dilution risk).");

  risk = Math.min(100, risk);
  const verdict = risk >= 60 ? "avoid" : risk >= 30 ? "caution" : "hold";

  return {
    address,
    isB20: true,
    variant: s.variant,
    symbol: s.symbol,
    riskScore: risk, // 0-100, higher = more issuer control over your funds
    verdict, // hold | caution | avoid
    powers: {
      seizable: s.canSeize,
      freezable: s.transferGated,
      pausedNow: s.paused.transfer,
      rebase: s.rebase,
      uncappedMint: !s.supplyCapped,
    },
    flags,
    recommendation:
      verdict === "avoid"
        ? "Avoid holding size — the issuer can freeze or seize your balance at the protocol level."
        : verdict === "caution"
          ? "Usable but the issuer retains control (policy/rebase/uncapped). Size accordingly and re-check before large positions."
          : "No high-control powers detected — behaves close to a plain token.",
    note: "B20 is Base's native precompile token standard. Unlike ERC-20, issuers can freeze (Policy Registry) and seize (burnBlocked) at the protocol level — this reads exactly those powers. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
