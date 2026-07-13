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

export async function signGuard(params: Record<string, string>) {
  const data = (params.data || params.calldata || "").trim();
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data)) throw new Error("Provide the transaction calldata to inspect (data=0x…, at least a 4-byte selector)");
  const to = (params.to || params.token || params.contract || "").trim();
  const target = isAddr(to) ? getAddress(to) : null;

  const intent = decodeIntent(data as Hex);
  const grantee = intent?.grantee && isAddr(intent.grantee) ? getAddress(intent.grantee) : null;

  // Screen destination + grantee (best-effort; contract-danger uses Sourcify and
  // can be momentarily down — never block the verdict on it).
  const [destDangerR, destSancR, granteeSancR] = await Promise.allSettled([
    target ? contractDanger({ address: target }) : Promise.resolve(null),
    target ? sanctionsCheck({ address: target }) : Promise.resolve(null),
    grantee ? sanctionsCheck({ address: grantee }) : Promise.resolve(null),
  ]);
  const destDanger = (destDangerR.status === "fulfilled" ? destDangerR.value : null) as { verified?: boolean; dangerLevel?: string; dangerCategories?: string[] } | null;
  const destSanctioned = destSancR.status === "fulfilled" && (destSancR.value as { sanctioned?: boolean } | null)?.sanctioned === true;
  const granteeSanctioned = granteeSancR.status === "fulfilled" && (granteeSancR.value as { sanctioned?: boolean } | null)?.sanctioned === true;

  const destCritical = destDanger?.dangerLevel === "critical";
  const destUnverified = destDanger?.verified === false;

  const observedRisks: string[] = [];
  let stop = false, hold = false;

  if (!intent) { observedRisks.push("unrecognized calldata — intent could NOT be decoded; sign only if you built this call yourself"); hold = true; }
  if (destSanctioned) { observedRisks.push("destination contract is on the OFAC sanctions list"); stop = true; }
  if (granteeSanctioned) { observedRisks.push("the spender/recipient is on the OFAC sanctions list"); stop = true; }
  if (intent?.unlimited) { observedRisks.push(`grants UNLIMITED power (${intent.action}) — the classic wallet-drain vector`); hold = true; }
  if (intent?.unlimited && (destUnverified || destCritical)) { observedRisks.push("unlimited approval to an unverified/dangerous contract"); stop = true; }
  if (destCritical) { observedRisks.push(`destination has critical owner powers (${(destDanger?.dangerCategories || []).join(", ")})`); hold = true; }
  if (destUnverified) { observedRisks.push("destination contract source is not verified — you can't inspect what it does"); hold = true; }
  if (intent && /transfer/.test(intent.action)) { observedRisks.push("moves funds out of the signer"); hold = true; }

  const decision = stop ? "STOP" : hold ? "HOLD" : "GO";

  return {
    to: target,
    signing: intent
      ? { action: intent.action, grantee, amount: intent.amount?.toString() ?? null, unlimited: intent.unlimited, human: intent.human }
      : { action: "unknown", human: "unrecognized calldata (not a standard approve/transfer/permit)" },
    decision, // GO | HOLD | STOP
    observedRisks,
    checks: {
      destinationSanctioned: destSanctioned,
      granteeSanctioned,
      destinationVerified: destDanger ? destDanger.verified !== false : null,
      destinationDanger: destDanger?.dangerLevel ?? null,
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
    note: "Decodes unsigned calldata (approve/permit/transfer/setApprovalForAll) and screens the destination + spender for OFAC + owner-abuse powers, in one GO/HOLD/STOP verdict. No simulation — pure decode + onchain risk. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
