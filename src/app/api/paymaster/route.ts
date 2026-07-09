/**
 * Paymaster proxy — sponsors gas for WalletProtect revokes ONLY.
 *
 * EIP-7677: smart wallets (Base App / Coinbase Smart Wallet) call
 * pm_getPaymasterStubData / pm_getPaymasterData on this URL when we pass it as
 * the paymasterService capability in wallet_sendCalls. We validate that the
 * userOperation is nothing but approve(spender, 0) calls (revokes), rate-limit
 * per sender, and forward to the CDP Paymaster RPC (PAYMASTER_RPC_URL env).
 *
 * Never expose PAYMASTER_RPC_URL to the client — this proxy IS the policy gate.
 */

import { NextRequest, NextResponse } from "next/server";
import { kvIncr } from "@/lib/kv";

export const dynamic = "force-dynamic";

const ALLOWED_METHODS = new Set(["pm_getPaymasterStubData", "pm_getPaymasterData"]);
// approve(spender, 0): selector + 32-byte spender + 32-byte zero amount.
const APPROVE_ZERO = /095ea7b3[0-9a-f]{64}0{64}/i;
// Selectors that must NOT ride along in a sponsored batch (value moves/approvals).
const FORBIDDEN = [
  "a9059cbb", // transfer
  "23b872dd", // transferFrom
  "d0e30db0", // deposit
  "2e1a7d4d", // withdraw
];
const DAILY_SPONSOR_CAP = 10; // sponsored ops per sender per day

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

  // params[0] = userOperation; its callData must be revoke-only.
  const userOp = (body.params?.[0] ?? {}) as { sender?: string; callData?: string };
  const callData = (userOp.callData ?? "").toLowerCase();
  if (!APPROVE_ZERO.test(callData)) return reject("only approve(spender, 0) revokes are sponsored");
  if (FORBIDDEN.some((sel) => callData.includes(sel))) return reject("batch contains non-revoke calls");
  // No non-zero approve: every approve selector occurrence must be the zero-amount form.
  const approves = callData.match(/095ea7b3[0-9a-f]{128}/g) ?? [];
  if (approves.some((a) => !/0{64}$/.test(a))) return reject("non-zero approvals are not sponsored");

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
