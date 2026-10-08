/**
 * Transaction simulation — "will this transaction succeed, what will it cost, and
 * is it a risky one?" — answered BEFORE an agent signs.
 *
 * The highest-stakes pre-execution question an agent faces, and the one the MEV /
 * agent-safety research keeps naming: simulate first, block on failure. An earlier
 * version used Alchemy's asset-change tracer, which Base's RPC does not serve
 * ("JS Tracer is not enabled"), so it was disabled. This version uses only the
 * universally-supported reads — `eth_call` for success/revert, `eth_estimateGas`
 * for cost — plus calldata decoding for the drain-vector risks. No metered
 * upstream, works on any Base RPC.
 *
 * What it returns from the sender's perspective:
 *   - willSucceed / revertReason — does this exact tx execute against live state?
 *   - gasEstimate + gasCostEth — what it costs at the current gas price
 *   - method + approval decoding — approve / setApprovalForAll / permit, and
 *     whether the amount is UNLIMITED (the classic drain the agent must see)
 *
 * It does NOT enumerate every token that moves (that needed the tracer). It
 * answers the three things that decide whether to sign: will it work, what does
 * it cost, and is it silently granting someone the power to drain you.
 */

import "server-only";
import { createPublicClient, getAddress, parseEther, formatEther, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });
const MAX_UINT = 2n ** 256n - 1n;
/** Treat an allowance within a factor of uint256-max as effectively unlimited. */
const UNLIMITED_FLOOR = 2n ** 255n;

function reqAddr(raw: string, label: string): Address {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`Provide a valid 0x… ${label} address`);
  return getAddress(v);
}

/** value may be decimal ETH ("0.1") or a 0x-hex wei value; normalise to bigint wei. */
function toWei(raw?: string): bigint {
  const v = (raw || "").trim();
  if (!v || v === "0") return 0n;
  if (v.startsWith("0x")) return BigInt(v);
  try {
    return parseEther(v);
  } catch {
    throw new Error("value must be ETH (e.g. 0.1) or a 0x hex wei amount");
  }
}

const SELECTORS: Record<string, string> = {
  "0x095ea7b3": "approve",
  "0xa22cb465": "setApprovalForAll",
  "0x39509351": "increaseAllowance",
  "0xd505accf": "permit",
  "0x23b872dd": "transferFrom",
  "0xa9059cbb": "transfer",
};

/** 32-byte word at index i of the calldata args (after the 4-byte selector). */
function word(data: string, i: number): string {
  const start = 10 + i * 64;
  return data.slice(start, start + 64);
}
const wordToAddr = (w: string) => ("0x" + w.slice(24)).toLowerCase();
const wordToBig = (w: string) => (w ? BigInt("0x" + w) : 0n);

export async function simulateTx(params: Record<string, string>) {
  const from = reqAddr(params.from || "", "from (sender)");
  const to = reqAddr(params.to || "", "to (recipient/contract)");
  const data = (params.data || params.calldata || "0x").trim() as Hex;
  if (data !== "0x" && !/^0x[0-9a-fA-F]*$/.test(data)) throw new Error("data/calldata must be 0x-prefixed hex");
  const value = toWei(params.value);

  // 1) Will it execute? eth_call runs the tx against live state and reverts with
  //    the contract's own reason if it would fail — the headline signal.
  let willSucceed: boolean;
  let revertReason: string | null = null;
  try {
    await client.call({ account: from, to, data, value });
    willSucceed = true;
  } catch (e) {
    willSucceed = false;
    const err = e as { shortMessage?: string; details?: string; message?: string };
    revertReason = (err.shortMessage || err.details || err.message || "execution reverted").split("\n")[0].slice(0, 200);
  }

  // 2) What will it cost? estimateGas also reverts on a failing tx, so it doubles
  //    as a check; a null estimate on an otherwise-succeeding call is just the
  //    node declining to estimate, not a failure.
  let gasEstimate: string | null = null;
  let gasCostEth: string | null = null;
  try {
    const gas = await client.estimateGas({ account: from, to, data, value });
    const gasPrice = await client.getGasPrice();
    gasEstimate = gas.toString();
    gasCostEth = formatEther(gas * gasPrice);
  } catch {
    /* estimate unavailable — leave null; the call result above is authoritative */
  }

  // 3) Decode the risky bits straight from calldata — no tracer needed.
  const selector = data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;
  const method = selector ? (SELECTORS[selector] ?? null) : null;
  const flags: string[] = [];
  let approval: { spender: string; amount: string; unlimited: boolean } | null = null;
  let setApprovalForAll: { operator: string; approved: boolean } | null = null;

  if (method === "approve" || method === "increaseAllowance") {
    const spender = wordToAddr(word(data, 0));
    const amount = wordToBig(word(data, 1));
    const unlimited = amount >= UNLIMITED_FLOOR;
    approval = { spender, amount: amount === MAX_UINT ? "unlimited (uint256 max)" : amount.toString(), unlimited };
    flags.push("grants_approval");
    if (unlimited) flags.push("unlimited_approval");
  } else if (method === "setApprovalForAll") {
    const operator = wordToAddr(word(data, 0));
    const approved = wordToBig(word(data, 1)) !== 0n;
    setApprovalForAll = { operator, approved };
    if (approved) flags.push("set_approval_for_all");
  } else if (method === "permit") {
    flags.push("grants_approval");
    const amount = wordToBig(word(data, 2));
    if (amount >= UNLIMITED_FLOOR) flags.push("unlimited_approval");
  }
  if (value > 0n) flags.push("sends_native");
  if (!willSucceed) flags.push("would_revert");

  const riskLevel =
    flags.includes("unlimited_approval") || flags.includes("set_approval_for_all")
      ? "high"
      : !willSucceed
        ? "review"
        : flags.includes("grants_approval") || flags.includes("sends_native")
          ? "medium"
          : "low";

  return {
    from,
    to,
    method, // decoded method if recognised (approve, setApprovalForAll, transfer, …)
    willSucceed,
    revertReason, // the contract's own reason when it would fail
    gasEstimate,
    gasCostEth,
    valueEth: value > 0n ? formatEther(value) : "0",
    riskLevel, // low | medium | review | high
    flags, // machine-readable: would_revert, unlimited_approval, set_approval_for_all, grants_approval, sends_native
    ...(approval ? { approval } : {}),
    ...(setApprovalForAll ? { setApprovalForAll } : {}),
    recommendation: !willSucceed
      ? `Do NOT sign — this transaction reverts against current state${revertReason ? `: ${revertReason}` : ""}. Fix the cause before sending.`
      : flags.includes("unlimited_approval") || flags.includes("set_approval_for_all")
        ? "Executes, but grants UNLIMITED spending/transfer power to the spender — the classic drain vector. Approve an exact amount instead, or only if you fully trust the spender."
        : flags.includes("grants_approval")
          ? "Executes and grants a bounded approval. Confirm the spender is one you intend to fund."
          : "Executes against current state. State can change before you sign — simulate again immediately before submitting.",
    note: "Pre-sign simulation on live Base state: eth_call for success/revert, eth_estimateGas for cost, and calldata decoding for approval/drain risk. Does not enumerate every token that moves (that needs a tracer Base's RPC doesn't serve). Re-simulate just before signing. Not financial advice.",
    simulatedAt: new Date().toISOString(),
  };
}
