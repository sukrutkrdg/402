/**
 * Sign Guard — "should this agent sign THIS calldata?" (no simulation needed).
 *
 * The riskiest instant for an autonomous agent is the moment before it signs a
 * transaction. This decodes the raw calldata locally (approve / increaseAllowance
 * / setApprovalForAll / transfer / transferFrom / permit), surfaces the exact
 * intent (who gets power over what, and whether it's UNLIMITED), and screens the
 * destination + spender/recipient for OFAC sanctions and dangerous owner powers —
 * collapsed into one GO / HOLD / STOP verdict with an auditable receipt.
 *
 * Unlike pre-sign, it needs NO tx simulation (no Alchemy) — pure calldata decode
 * + our own onchain risk reads — so it runs everywhere. Deterministic, no LLM.
 */

import "server-only";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { contractDanger } from "./contract-danger";
import { sanctionsCheck } from "./compliance";
import { goPlusSecurity } from "./upstream-cache";
import { establishedContext } from "./established";

// Huge allowances (>= 2^200) are effectively unlimited — the classic drain vector.
const NEAR_UNLIMITED = 1n << 200n;

const ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "increaseAllowance", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "added", type: "uint256" }], outputs: [] },
  { type: "function", name: "setApprovalForAll", stateMutability: "nonpayable", inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "permit", stateMutability: "nonpayable", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [] },
] as const;

interface Intent {
  action: string;
  grantee: string | null; // spender / operator / recipient who gains power/funds
  amount: bigint | null;
  unlimited: boolean;
  human: string;
}

function decodeIntent(data: Hex): Intent | null {
  let d;
  try {
    d = decodeFunctionData({ abi: ABI, data });
  } catch {
    return null;
  }
  const a = d.args as readonly unknown[];
  const addr = (v: unknown) => (typeof v === "string" ? v : null);
  switch (d.functionName) {
    case "approve": {
      const amt = a[1] as bigint;
      const unlimited = amt >= NEAR_UNLIMITED;
      return { action: "approve", grantee: addr(a[0]), amount: amt, unlimited, human: `approve ${unlimited ? "UNLIMITED" : amt.toString()} to ${addr(a[0])}` };
    }
    case "increaseAllowance": {
      const amt = a[1] as bigint;
      return { action: "increaseAllowance", grantee: addr(a[0]), amount: amt, unlimited: amt >= NEAR_UNLIMITED, human: `increase allowance by ${amt.toString()} to ${addr(a[0])}` };
    }
    case "setApprovalForAll": {
      const approved = a[1] as boolean;
      return { action: "setApprovalForAll", grantee: addr(a[0]), amount: null, unlimited: approved, human: `${approved ? "GRANT" : "revoke"} approval-for-ALL NFTs to ${addr(a[0])}` };
    }
    case "transfer":
      return { action: "transfer", grantee: addr(a[0]), amount: a[1] as bigint, unlimited: false, human: `transfer ${(a[1] as bigint).toString()} to ${addr(a[0])}` };
    case "transferFrom":
      return { action: "transferFrom", grantee: addr(a[1]), amount: a[2] as bigint, unlimited: false, human: `transferFrom ${addr(a[0])} → ${addr(a[1])} of ${(a[2] as bigint).toString()}` };
    case "permit": {
      const value = a[2] as bigint;
      return { action: "permit", grantee: addr(a[1]), amount: value, unlimited: value >= NEAR_UNLIMITED, human: `permit ${value >= NEAR_UNLIMITED ? "UNLIMITED" : value.toString()} to ${addr(a[1])} (gasless approval)` };
    }
    default:
      return null;
  }
}

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

// EIP-8430 Base Transactions / EIP-5792 / smart-account executors bundle many
// calls behind ONE signature. A drain approval hidden in call #3 would otherwise
// read as "unrecognized calldata" (an opaque HOLD). Decode the standard batch
// shapes so every inner call is inspected like a top-level one.
const BATCH_ABI = [
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [] },
  { type: "function", name: "executeBatch", stateMutability: "payable", inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], outputs: [] },
  { type: "function", name: "executeBatch", stateMutability: "payable", inputs: [{ name: "to", type: "address[]" }, { name: "value", type: "uint256[]" }, { name: "data", type: "bytes[]" }], outputs: [] },
  { type: "function", name: "execute", stateMutability: "payable", inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], outputs: [] },
] as const;

interface InnerCall {
  to: string | null;
  data: Hex;
}
/** Decode a batched/smart-account execute into its inner calls, or null if not a batch. */
function decodeBatch(data: Hex): InnerCall[] | null {
  let d;
  try {
    d = decodeFunctionData({ abi: BATCH_ABI, data });
  } catch {
    return null;
  }
  const a = d.args as readonly unknown[];
  if (d.functionName === "multicall") {
    return (a[0] as readonly Hex[]).map((cd) => ({ to: null, data: cd }));
  }
  const first = a[0];
  // execute/executeBatch(tuple[]) — a list of {to,value,data}
  if (Array.isArray(first) && first.length > 0 && typeof first[0] === "object") {
    return (first as readonly { to?: string; data?: Hex }[]).map((c) => ({ to: c.to ?? null, data: (c.data ?? "0x") as Hex }));
  }
  // executeBatch(address[],uint256[],bytes[]) — parallel arrays
  if (Array.isArray(first) && Array.isArray(a[2])) {
    const tos = first as readonly string[];
    return (a[2] as readonly Hex[]).map((cd, i) => ({ to: tos[i] ?? null, data: cd }));
  }
  return null;
}

export async function signGuard(params: Record<string, string>) {
  const data = (params.data || params.calldata || "").trim();
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data)) throw new Error("Provide the transaction calldata to inspect (data=0x…, at least a 4-byte selector)");
  const to = (params.to || params.token || params.contract || "").trim();
  const target = isAddr(to) ? getAddress(to) : null;

  const intent = decodeIntent(data as Hex);
  // If it isn't a known single call, it may be an EIP-8430/5792/smart-account
  // batch — decode and inspect each inner call so nothing hides behind the bundle.
  const batchRaw = intent ? null : decodeBatch(data as Hex);
  const batchCalls = batchRaw?.map((c) => ({ to: c.to && isAddr(c.to) ? getAddress(c.to) : null, intent: decodeIntent(c.data) })) ?? null;
  const grantee = intent?.grantee && isAddr(intent.grantee) ? getAddress(intent.grantee) : null;

  // Screen destination + grantee (best-effort; contract-danger uses Sourcify and
  // can be momentarily down — never block the verdict on it).
  const [destDangerR, destSancR, granteeSancR] = await Promise.allSettled([
    target ? contractDanger({ address: target }) : Promise.resolve(null),
    target ? sanctionsCheck({ address: target }) : Promise.resolve(null),
    grantee ? sanctionsCheck({ address: grantee }) : Promise.resolve(null),
  ]);
  const destDanger = (destDangerR.status === "fulfilled" ? destDangerR.value : null) as { verified?: boolean; dangerLevel?: string; dangerCategories?: string[] } | null;
  // Tri-state: true = sanctioned, false = screened clean, null = screen didn't
  // run (list outage). A rejected check must NOT collapse to "clean" — that would
  // let a scoped approve to a sanctioned spender return GO during an outage.
  const readSanc = (r: PromiseSettledResult<unknown>, requested: boolean): boolean | null => {
    if (!requested) return false; // nothing to screen (no target/grantee) → not a risk
    if (r.status !== "fulfilled" || r.value == null) return null;
    return (r.value as { sanctioned?: boolean }).sanctioned === true;
  };
  const destSanctioned = readSanc(destSancR, !!target);
  const granteeSanctioned = readSanc(granteeSancR, !!grantee);
  const sanctionsUnavailable = (!!target && destSanctioned === null) || (!!grantee && granteeSanctioned === null);

  // Screen every counterparty INSIDE a batch (bounded) — a drain can route
  // through an inner call rather than the outer executor the agent sees.
  const innerParties: string[] = batchCalls
    ? [...new Set(batchCalls.flatMap((c) => {
        const out: string[] = [];
        if (c.to) out.push(c.to);
        if (c.intent?.grantee && isAddr(c.intent.grantee)) out.push(getAddress(c.intent.grantee));
        return out;
      }))].slice(0, 8)
    : [];
  const innerSancR = innerParties.length ? await Promise.allSettled(innerParties.map((p) => sanctionsCheck({ address: p }))) : [];
  const innerSanctioned = innerParties.filter((_, i) => innerSancR[i]?.status === "fulfilled" && (innerSancR[i] as PromiseFulfilledResult<{ sanctioned?: boolean }>).value?.sanctioned === true);

  // A revoke (approve 0, or setApprovalForAll false) can only shrink what the
  // signer has exposed. Holding it over the destination's owner powers told an
  // agent cleaning up its approvals on USDC to wait (2026-10-17).
  const revoke = !!intent && ((intent.action === "approve" && intent.amount === 0n) || (intent.action === "setApprovalForAll" && !intent.unlimited));
  // On an established token (see established.ts) an upgradeable implementation
  // is how the issuer runs it — USDC is a proxy — not a risk of this signature.
  // Only "upgrade" moves to context; blacklist and every other power still holds.
  const categories = destDanger?.dangerCategories ?? [];
  let destContext: string[] = [];
  let established: string | null = null;
  if (target && destDanger?.dangerLevel === "critical" && categories.length > 0 && categories.every((c) => c === "upgrade")) {
    const gp = await goPlusSecurity<Record<string, unknown>>(target).catch(() => null);
    if (gp) {
      const disq = ["is_honeypot", "hidden_owner", "can_take_back_ownership", "is_airdrop_scam"].filter((k) => String(gp[k]) === "1");
      const holders = gp.holder_count !== undefined ? Number(gp.holder_count) : null;
      const ctx = await establishedContext(target, Number.isFinite(holders) ? holders : null, disq);
      established = ctx.basis;
      if (ctx.established) destContext = ["upgrade"];
    }
  }
  const destCritical = destDanger?.dangerLevel === "critical" && destContext.length === 0;
  const destUnverified = destDanger?.verified === false;

  const observedRisks: string[] = [];
  let stop = false, hold = false;

  if (!intent && !batchCalls) { observedRisks.push("unrecognized calldata — intent could NOT be decoded; sign only if you built this call yourself"); hold = true; }
  if (batchCalls) {
    const n = batchCalls.length;
    const anyUnlimited = batchCalls.some((c) => c.intent?.unlimited);
    const anyTransfer = batchCalls.some((c) => c.intent && /transfer/.test(c.intent.action));
    const undecodable = batchCalls.filter((c) => !c.intent).length;
    observedRisks.push(`bundles ${n} call${n === 1 ? "" : "s"} behind ONE signature (batched/EIP-8430 tx) — each inner call must be inspected, not just the outer one`);
    hold = true;
    if (anyUnlimited) { observedRisks.push("a call inside the batch grants UNLIMITED power — the classic drain vector"); hold = true; }
    if (anyTransfer) observedRisks.push("a call inside the batch moves funds out of the signer");
    if (undecodable) observedRisks.push(`${undecodable} call(s) in the batch could not be decoded — sign only if you built them yourself`);
    if (innerSanctioned.length) { observedRisks.push("a counterparty inside the batch is on the OFAC sanctions list"); stop = true; }
  }
  if (destSanctioned === true) { observedRisks.push("destination contract is on the OFAC sanctions list"); stop = true; }
  if (granteeSanctioned === true) { observedRisks.push("the spender/recipient is on the OFAC sanctions list"); stop = true; }
  if (sanctionsUnavailable) { observedRisks.push("OFAC sanctions screening was unavailable this call — could not confirm the counterparty is not sanctioned"); hold = true; }
  if (intent?.unlimited) { observedRisks.push(`grants UNLIMITED power (${intent.action}) — the classic wallet-drain vector`); hold = true; }
  // contract-danger (Sourcify) down is UNKNOWN, not clean: hold, and an unlimited
  // grant to a contract we couldn't inspect is treated like an unverified one.
  const destUninspected = !!target && destDangerR.status === "rejected";
  if (destUninspected) { observedRisks.push("destination contract could not be inspected this call (source registry unavailable)"); hold = true; }
  if (intent?.unlimited && destUninspected) { observedRisks.push("unlimited approval to a contract that could not be inspected"); stop = true; }
  if (intent?.unlimited && (destUnverified || destCritical)) { observedRisks.push("unlimited approval to an unverified/dangerous contract"); stop = true; }
  if (destCritical) { observedRisks.push(`destination has critical owner powers (${(destDanger?.dangerCategories || []).join(", ")})`); if (!revoke) hold = true; }
  if (destUnverified) { observedRisks.push("destination contract source is not verified — you can't inspect what it does"); if (!revoke) hold = true; }
  if (intent && /transfer/.test(intent.action)) { observedRisks.push("moves funds out of the signer"); hold = true; }

  const decision = stop ? "STOP" : hold ? "HOLD" : "GO";

  return {
    to: target,
    signing: intent
      ? { action: intent.action, grantee, amount: intent.amount?.toString() ?? null, unlimited: intent.unlimited, human: intent.human }
      : batchCalls
        ? {
            action: "batch",
            human: `batched transaction of ${batchCalls.length} call${batchCalls.length === 1 ? "" : "s"} (EIP-8430 / smart-account execute)`,
            calls: batchCalls.map((c) => ({ to: c.to, action: c.intent?.action ?? "unknown", unlimited: c.intent?.unlimited ?? false, grantee: c.intent?.grantee ?? null, human: c.intent?.human ?? "undecodable inner call" })),
          }
        : { action: "unknown", human: "unrecognized calldata (not a standard approve/transfer/permit)" },
    decision, // GO | HOLD | STOP
    observedRisks,
    checks: {
      destinationSanctioned: destSanctioned,
      granteeSanctioned,
      destinationVerified: destDanger ? destDanger.verified !== false : null,
      destinationDanger: destDanger?.dangerLevel ?? null,
      // Owner powers reported but not scored, and why.
      ...(destContext.length ? { destinationContext: destContext, established } : {}),
      ...(revoke ? { revoke: true } : {}),
    },
    receipt: {
      checked: (data as string).slice(0, 10) + "…",
      to: target,
      decision,
      at: new Date().toISOString(),
      endpoint: "sign-guard",
      observedRisks,
      wouldChangeCall: stop
        ? "Nothing while a terminal flag (sanctioned party / unlimited-to-dangerous) stands — do not sign."
        : "A scoped (non-unlimited) amount, a verified destination, or a known spender — re-check.",
    },
    recommendation:
      decision === "STOP" ? "Do NOT sign — a terminal flag is set (sanctioned party or unlimited approval to a dangerous/unverified contract)."
        : decision === "HOLD" ? "Sign only if you intended exactly this — the call grants power or moves funds; prefer a scoped amount and a verified spender."
          : "No blocking flags — the decoded intent is a standard, scoped call. Re-check just before signing; state can change.",
    note: "Decodes unsigned calldata (approve/permit/transfer/setApprovalForAll — and unwraps EIP-8430/5792/smart-account BATCHES to inspect every inner call) and screens the destination + spender for OFAC + owner-abuse powers, in one GO/HOLD/STOP verdict. No simulation — pure decode + onchain risk. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
