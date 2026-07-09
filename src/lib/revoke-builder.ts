/**
 * Revoke Calldata Builder — "give me the exact transaction that kills this
 * approval."
 *
 * approval-advisor tells an agent WHAT to revoke; this builds the HOW: the
 * ready-to-sign transaction (to + calldata) for approve(spender, 0) on a given
 * token, with the current live allowance read from Base so you can see what
 * you're revoking and verify afterwards it went to zero. Deterministic
 * encoding + one free RPC read — the action half of approval hygiene.
 */

import "server-only";
import { createPublicClient, http, getAddress, encodeFunctionData, formatUnits } from "viem";
import { base } from "viem/chains";
import { getConfig } from "./config";
import { baseTransport } from "./base-transport";

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const MAX_UINT256 = (1n << 256n) - 1n;

function reqAddr(raw: string, label: string): `0x${string}` {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`Provide a valid 0x… ${label} address`);
  return getAddress(v);
}

export async function revokeBuilder(params: Record<string, string>) {
  const token = reqAddr(params.token || params.address || "", "token");
  const spender = reqAddr(params.spender || "", "spender");
  const walletRaw = (params.wallet || params.owner || "").trim();
  const wallet = walletRaw ? reqAddr(walletRaw, "wallet") : null;

  // The deliverable: calldata for approve(spender, 0). Deterministic — works
  // even if every RPC read below fails.
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, 0n] });

  const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

  let symbol: string | null = null;
  let decimals: number | null = null;
  let currentAllowance: string | null = null;
  let isUnlimited: boolean | null = null;
  let alreadyRevoked: boolean | null = null;
  try {
    const [symR, decR] = await Promise.allSettled([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    symbol = symR.status === "fulfilled" ? symR.value : null;
    decimals = decR.status === "fulfilled" ? Number(decR.value) : null;

    if (wallet) {
      const allowance = await client.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [wallet, spender],
      });
      isUnlimited = allowance >= MAX_UINT256 / 2n; // "effectively unlimited" (max or near-max patterns)
      alreadyRevoked = allowance === 0n;
      currentAllowance = isUnlimited
        ? "unlimited"
        : decimals !== null
          ? formatUnits(allowance, decimals)
          : allowance.toString();
    }
  } catch {
    // Reads are context, not the product — the revoke tx above is still valid.
  }

  return {
    token,
    symbol,
    spender,
    wallet,
    currentAllowance, // live allowance (null if no wallet given or read failed)
    isUnlimited,
    alreadyRevoked,
    transaction: {
      to: token, // approvals live on the TOKEN contract, not the spender
      data, // approve(spender, 0)
      value: "0",
      chainId: base.id,
    },
    recommendation: alreadyRevoked
      ? "Allowance is already 0 — nothing to revoke."
      : isUnlimited
        ? `UNLIMITED ${symbol ?? "token"} allowance to ${spender} — sign the transaction below to revoke it now.`
        : "Sign the transaction below to set this allowance to 0. Verify afterwards by re-running with your wallet address.",
    note: "Send the transaction from the wallet that granted the approval. Some non-standard tokens (e.g. USDT-style) require approving 0 before any new approval — this tx is exactly that. Simulate first with pre-sign if unsure.",
    checkedAt: new Date().toISOString(),
  };
}
