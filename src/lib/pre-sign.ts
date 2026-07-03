/**
 * Pre-Sign Preflight — "should this agent sign THIS transaction?"
 *
 * The single highest-stakes moment for an autonomous agent is the instant before
 * it signs. This bundles the three checks that answer it into one call and one
 * verdict: a live simulation of the unsigned tx (what leaves, what approvals it
 * grants, whether it reverts), a danger scan of the destination contract (owner
 * abuse powers), and an OFAC screen of the destination. Deterministic verdict —
 * no LLM, no per-call model cost.
 *
 * Metered upstream (Alchemy, via the simulation) → registered paid-only.
 */

import "server-only";
import { simulateTx } from "./tx-sim";
import { contractDanger } from "./contract-danger";
import { sanctionsCheck } from "./compliance";

interface SimShape {
  willRevert?: boolean;
  revertReason?: string | null;
  riskLevel?: string;
  flags?: string[];
  method?: string | null;
  summary?: { assetsOut?: number; assetsIn?: number; approvalsGranted?: number };
}
interface DangerShape {
  verified?: boolean;
  dangerLevel?: string;
  dangerCategories?: string[];
}
interface SanctionsShape {
  sanctioned?: boolean;
}

function reqAddr(raw: string, label: string): string {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`Provide a valid 0x… ${label} address`);
  return v;
}

export async function preSignPreflight(params: Record<string, string>) {
  const from = reqAddr(params.from || "", "from (sender)");
  const to = reqAddr(params.to || "", "to (recipient/contract)");

  // Simulation is the load-bearing check — if it can't run (bad calldata,
  // upstream down, ALCHEMY_API_KEY unset) it throws here, pre-settlement, and the
  // buyer is not charged. Destination checks are best-effort context.
  const sim = (await simulateTx({
    from,
    to,
    data: params.data || params.calldata || "0x",
    value: params.value || "",
  })) as SimShape;

  const [dangerR, sanctionsR] = await Promise.allSettled([
    contractDanger({ address: to }),
    sanctionsCheck({ address: to }),
  ]);
  const danger = (dangerR.status === "fulfilled" ? dangerR.value : null) as DangerShape | null;
  const sanctions = (sanctionsR.status === "fulfilled" ? sanctionsR.value : null) as SanctionsShape | null;

  const flags = sim.flags ?? [];
  const grantsUnlimited = flags.includes("unlimited_approval") || flags.includes("set_approval_for_all");
  const destSanctioned = Boolean(sanctions?.sanctioned);
  const destCritical = danger?.dangerLevel === "critical";
  const destUnverified = danger?.verified === false;

  const reasons: string[] = [];
  if (destSanctioned) reasons.push("Destination is on the OFAC sanctions list — do not transact.");
  if (grantsUnlimited)
    reasons.push("Transaction grants an UNLIMITED token approval / setApprovalForAll — the classic drain vector.");
  if (destCritical)
    reasons.push(`Destination contract has critical owner powers (${(danger?.dangerCategories || []).join(", ")}).`);
  if (sim.willRevert) reasons.push(`Transaction would REVERT: ${sim.revertReason || "unknown reason"}.`);
  if (destUnverified) reasons.push("Destination contract source is not verified — you can't inspect what it does.");
  if (flags.includes("moves_assets_out")) reasons.push("Transaction moves assets out of the sender.");

  // Decision: sanctions or an unlimited approval to a dangerous/unverified
  // destination is a hard block; a revert is a hard fail; asset movement or a
  // scoped approval is caution; otherwise allow.
  let decision: "block" | "would_fail" | "caution" | "allow";
  if (destSanctioned || (grantsUnlimited && (destCritical || destUnverified))) {
    decision = "block";
  } else if (sim.willRevert) {
    decision = "would_fail";
  } else if (grantsUnlimited || destCritical || flags.includes("moves_assets_out") || flags.includes("grants_approval")) {
    decision = "caution";
  } else {
    decision = "allow";
  }

  return {
    from,
    to,
    method: sim.method ?? null,
    decision, // allow | caution | would_fail | block
    reasons,
    simulation: sim, // full tx-sim result
    destination: danger, // contract-danger result for `to` (null if unavailable)
    sanctions, // OFAC screen of `to` (null if unavailable)
    note: "One-call go/no-go for an unsigned tx: live simulation + destination danger scan + OFAC screen. Re-check just before signing; state can change. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
