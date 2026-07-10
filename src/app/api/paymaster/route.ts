/**
 * Paymaster proxy — sponsors gas for WalletProtect revokes ONLY.
 *
 * EIP-7677: smart wallets (Base App / Coinbase Smart Wallet) call
 * pm_getPaymasterStubData / pm_getPaymasterData on this URL when we pass it as
 * the paymasterService capability in wallet_sendCalls. We DECODE the smart
 * wallet's execute/executeBatch callData and sponsor only if EVERY inner call is
 * exactly approve(spender, 0) with zero ETH value — a strict allowlist, not a
 * substring denylist (a denylist is bypassable via increaseAllowance /
 * setApprovalForAll / embedded junk). Anything we can't decode is rejected.
 *
 * Never expose PAYMASTER_RPC_URL to the client — this proxy IS the policy gate.
 */

import { NextRequest, NextResponse } from "next/server";
import { decodeFunctionData } from "viem";
import { kvIncr } from "@/lib/kv";

export const dynamic = "force-dynamic";

const ALLOWED_METHODS = new Set(["pm_getPaymasterStubData", "pm_getPaymasterData"]);
const DAILY_SPONSOR_CAP = 10; // sponsored ops per sender per day

// Smart-wallet batch entrypoints we understand (Coinbase Smart Wallet / common 4337).
const EXEC_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const APPROVE_SELECTOR = "0x095ea7b3";

/** True iff `data` is exactly approve(spender, 0). */
function isZeroApprove(data: string): boolean {
  const d = (data || "").toLowerCase();
  if (!d.startsWith(APPROVE_SELECTOR)) return false;
  const body = d.slice(10); // strip selector
  if (body.length !== 128) return false; // must be exactly (address, uint256)
  return /^0{64}$/.test(body.slice(64)); // amount == 0
}

/** Sponsor only if every inner call is a zero-value approve(spender,0). */
function isRevokeOnly(callData: string): boolean {
  if (!callData || callData === "0x") return false;
  // Bare approve(spender,0) (some wallets pass the call directly).
  if (isZeroApprove(callData)) return true;
  try {
    const decoded = decodeFunctionData({ abi: EXEC_ABI, data: callData as `0x${string}` });
    if (decoded.functionName === "execute") {
      const [, value, data] = decoded.args as [string, bigint, string];
      return value === 0n && isZeroApprove(data);
    }
    if (decoded.functionName === "executeBatch") {
      const [calls] = decoded.args as [ReadonlyArray<{ value: bigint; data: string }>];
      return calls.length > 0 && calls.every((c) => c.value === 0n && isZeroApprove(c.data));
    }
    return false;
  } catch {
    return false; // opaque/unknown callData → never sponsor
  }
}

export async function POST(req: NextRequest) {
  const upstream = process.env.PAYMASTER_RPC_URL;
  if (!upstream) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "paymaster not configured" } }, { status: 200 });
  }

  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 200 });
  }
  const id = body.id ?? null;
  const reject = (message: string) =>
    NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32001, message } }, { status: 200 });

  if (!body.method || !ALLOWED_METHODS.has(body.method)) return reject("method not sponsored");

  const userOp = (body.params?.[0] ?? {}) as { sender?: string; callData?: string };
  const callData = (userOp.callData ?? "").toLowerCase();
  if (!isRevokeOnly(callData)) return reject("only approve(spender, 0) revokes are sponsored");

  // Per-sender daily cap (only on the final sponsorship call, not the stub).
  if (body.method === "pm_getPaymasterData") {
    const sender = (userOp.sender ?? "unknown").toLowerCase();
    const day = new Date().toISOString().slice(0, 10);
    const n = await kvIncr(`pm:day:${sender}:${day}`, 60 * 60 * 25);
    if (n === null || n > DAILY_SPONSOR_CAP) return reject("daily sponsorship limit reached");
  }

  try {
    const r = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    return NextResponse.json(j, { status: 200 });
  } catch {
    return reject("paymaster upstream unavailable");
  }
}
