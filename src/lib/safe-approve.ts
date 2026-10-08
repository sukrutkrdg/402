/**
 * Safe approve builder — the exact-amount ERC-20 approval, never unlimited.
 *
 * Unlimited allowances are the #1 drain vector, and agents grant them constantly:
 * every swap wants an approval, and the path of least resistance is approve(max).
 * The rest of the approval family DETECTS the danger after the fact — simulate-tx
 * and sign-guard flag an unlimited approve, approval-advisor audits live ones,
 * wallet-drain-watch scores the surface, revoke-builder sets one back to 0. This
 * is the build-time PREVENTION: give an agent the ready-to-sign calldata for an
 * approval of EXACTLY the amount it needs, so it never has to reach for max.
 *
 * It refuses to build an unlimited approval unless explicitly forced, converts
 * the human amount using the token's own decimals, reads the current live
 * allowance, and warns about the zero-first quirk: some tokens (USDT-style)
 * revert a non-zero→non-zero approve, so when an allowance is already set it
 * returns a revoke step first. Returns ready-to-send transactions; we never hold
 * funds or keys.
 */

import "server-only";
import { createPublicClient, getAddress, encodeFunctionData, parseUnits, formatUnits, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";

const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const MAX_UINT256 = (1n << 256n) - 1n;
const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

function reqAddr(raw: string, label: string): Address {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`Provide a valid 0x… ${label} address`);
  return getAddress(v);
}

const isUnlimitedWord = (s: string) => /^(max|unlimited|infinite)$/i.test(s.trim());

export async function safeApprove(params: Record<string, string>) {
  const token = reqAddr(params.token || params.address || "", "token");
  const spender = reqAddr(params.spender || "", "spender");
  const amountRaw = (params.amount || "").trim();
  if (!amountRaw) throw new Error("Provide the exact amount to approve (amount=100), or amount=max with allowUnlimited=1 to grant unlimited (not recommended)");
  const owner = /^0x[0-9a-fA-F]{40}$/.test((params.owner || params.wallet || "").trim()) ? getAddress((params.owner || params.wallet).trim()) : null;
  const wantUnlimited = isUnlimitedWord(amountRaw);
  const allowUnlimited = /^(1|true|yes)$/i.test((params.allowUnlimited || "").trim());
  if (wantUnlimited && !allowUnlimited) {
    throw new Error("Refusing to build an UNLIMITED approval — it is the #1 drain vector. Pass an exact amount (amount=100), or amount=max with allowUnlimited=1 if you truly intend it.");
  }

  // Token decimals/symbol — best-effort; decimals is required to convert a human
  // amount, so a failed read on a real amount is an error (not charged by the
  // handler contract), never a silent wrong scale.
  let decimals: number | null = null;
  let symbol: string | null = null;
  try {
    [decimals, symbol] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }) as Promise<number>,
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => null) as Promise<string | null>,
    ]);
  } catch {
    throw new Error(`Could not read ${token} decimals — it may not be an ERC-20 on Base. Not charged.`);
  }

  let amountUnits: bigint;
  if (wantUnlimited) {
    amountUnits = MAX_UINT256;
  } else {
    try {
      amountUnits = parseUnits(amountRaw, decimals as number);
    } catch {
      throw new Error(`amount must be a number in ${symbol ?? "token"} units (e.g. 100), or 'max'`);
    }
    if (amountUnits < 0n) throw new Error("amount must be non-negative");
  }

  // Current live allowance, if an owner is given — this decides the zero-first step.
  let currentAllowance: string | null = null;
  let currentUnits: bigint | null = null;
  if (owner) {
    try {
      currentUnits = (await client.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] })) as bigint;
      currentAllowance = currentUnits >= MAX_UINT256 / 2n ? "unlimited" : formatUnits(currentUnits, decimals as number);
    } catch {
      currentUnits = null;
    }
  }

  const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amountUnits] });
  const revokeData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, 0n] });
  const approveTx = { chainId: 8453, to: token, data: approveData, value: "0" };
  const revokeTx = { chainId: 8453, to: token, data: revokeData, value: "0" };

  // Zero-first: a non-zero → non-zero approve reverts on USDT-style tokens, and is
  // a front-running window on any token. When an allowance is already set and we
  // are setting another non-zero one, hand back the revoke as step 1.
  const needsZeroFirst = currentUnits !== null && currentUnits > 0n && amountUnits > 0n;

  const steps: string[] = [];
  if (needsZeroFirst) steps.push(`Step 1 — reset to zero first: send revokeTransaction (approve ${spender} 0). A non-zero→non-zero approve reverts on USDT-style tokens and opens a front-running window on any.`);
  steps.push(`${needsZeroFirst ? "Step 2 — " : ""}Send approveTransaction: approve(${spender}, ${wantUnlimited ? "UNLIMITED" : `${amountRaw} ${symbol ?? ""}`.trim()}) on ${symbol ?? token}.`);
  steps.push("When done with the spender, revoke with revokeTransaction (or revoke-builder).");

  return {
    token,
    symbol,
    spender,
    decimals,
    amountApproved: wantUnlimited ? "unlimited" : amountRaw,
    amountUnits: amountUnits.toString(),
    unlimited: wantUnlimited,
    ...(owner ? { owner, currentAllowance } : {}),
    needsZeroFirst,
    approveTransaction: approveTx,
    revokeTransaction: revokeTx,
    steps,
    recommendation: wantUnlimited
      ? "⚠️ You requested an UNLIMITED approval. The spender can move the full balance at any time, forever. Prefer an exact amount and re-approve when needed."
      : needsZeroFirst
        ? `An allowance is already set (${currentAllowance}). Send the revoke first, then the exact-amount approve — safer and avoids a USDT-style revert.`
        : `Grants exactly ${amountRaw} ${symbol ?? ""} to ${spender}, not a penny more. Revoke it when you are done.`,
    note: "Builds the exact-amount ERC-20 approve calldata (never unlimited unless forced) plus the matching revoke — the build-time prevention of the #1 drain vector. Ready-to-sign; we never hold funds or keys. Pass owner= to read the live allowance and get the zero-first step when needed. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
