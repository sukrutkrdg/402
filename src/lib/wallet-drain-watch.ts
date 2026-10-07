/**
 * Wallet drain-surface — the three ways an agent wallet gets emptied, in one verdict.
 *
 * Three endpoints already read one drain vector each: approval-advisor (ERC-20
 * approvals), spend-audit (Base Account spend permissions), wallet-delegation
 * (EIP-7702 delegation — a malicious delegate is total takeover). Nothing spans
 * all three, so an agent checking "can anything drain this wallet right now" has
 * to make three calls and combine them by hand. This composes them into one
 * GO/REVIEW/STOP over the whole surface — it does NOT re-implement any of them,
 * it calls them (the safe-to-send pattern) and keeps each sub-result for drill-down.
 *
 * Priority order, worst-first: a hostile 7702 delegate (owns everything) outranks
 * unbounded spend permissions, which outrank risky approvals. A vector whose read
 * failed is surfaced as "unknown" and forces at least REVIEW — a drain check that
 * silently skips a surface is the failure this exists to prevent.
 */

import "server-only";
import { approvalAdvisor } from "./approval-advisor";
import { spendAudit } from "./spend-audit";
import { walletDelegation } from "./delegation";

type V = "GO" | "REVIEW" | "STOP";
const rank: Record<V, number> = { GO: 0, REVIEW: 1, STOP: 2 };
const worse = (a: V, b: V) => (rank[a] >= rank[b] ? a : b);

export async function walletDrainWatch(params: Record<string, string>) {
  const raw = (params.wallet || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide the wallet to scan (wallet=0x…)");
  const wallet = raw;

  const [delR, apprR, spendR] = await Promise.allSettled([
    walletDelegation({ address: wallet }),
    approvalAdvisor({ address: wallet }),
    spendAudit({ wallet }),
  ]);

  let verdict: V = "GO";
  const vectors: Record<string, unknown> = {};
  const findings: string[] = [];

  // ---- 7702 delegation: the total-takeover vector, so it leads ----
  if (delR.status === "fulfilled") {
    const d = delR.value as { verdict?: string; delegated?: boolean; delegate?: string | null; delegateLabel?: string | null; delegateKnown?: boolean };
    vectors.delegation = d;
    if (d.verdict === "delegated_unknown") { verdict = worse(verdict, "STOP"); findings.push(`EIP-7702 delegated to an UNRECOGNISED delegate (${d.delegate}) — a hostile delegate controls approvals, balances, everything. Verify or undelegate.`); }
    else if (d.verdict === "delegated_known") { verdict = worse(verdict, "REVIEW"); findings.push(`Delegated to a known delegate (${d.delegateLabel ?? d.delegate}) — expected for a smart wallet, but confirm it is yours.`); }
  } else {
    vectors.delegation = { verdict: "unknown", error: "read failed" };
    verdict = worse(verdict, "REVIEW");
    findings.push("delegation read failed — 7702 takeover exposure UNKNOWN this call, not clear.");
  }

  // ---- spend permissions ----
  if (spendR.status === "fulfilled") {
    const s = spendR.value as { verdict?: string; highRiskCount?: number; activeCount?: number };
    vectors.spendPermissions = s;
    if (s.verdict === "action_required") { verdict = worse(verdict, "STOP"); findings.push(`${s.highRiskCount ?? 0} spend permission(s) grant effectively unbounded, non-expiring authority — a spender can pull the full allowance every period. Revoke any you don't recognise.`); }
    else if (s.verdict === "review") { verdict = worse(verdict, "REVIEW"); findings.push(`${s.activeCount ?? 0} active spend permission(s) warrant a look.`); }
  } else {
    vectors.spendPermissions = { verdict: "unknown", error: "read failed" };
    verdict = worse(verdict, "REVIEW");
    findings.push("spend-permission read failed — exposure UNKNOWN this call.");
  }

  // ---- ERC-20 approvals ----
  if (apprR.status === "fulfilled") {
    const a = apprR.value as { highPriorityCount?: number; approvalCount?: number; totalUsdAtRisk?: number };
    vectors.approvals = a;
    if ((a.highPriorityCount ?? 0) > 0) { verdict = worse(verdict, "STOP"); findings.push(`${a.highPriorityCount} high-priority approval(s): unlimited allowance to unknown spenders with ~$${a.totalUsdAtRisk ?? 0} at risk. Revoke worst-first.`); }
    else if ((a.totalUsdAtRisk ?? 0) > 0) { verdict = worse(verdict, "REVIEW"); findings.push(`${a.approvalCount ?? 0} approval(s), ~$${a.totalUsdAtRisk} at risk — trim what you no longer use.`); }
  } else {
    vectors.approvals = { error: "read failed" };
    verdict = worse(verdict, "REVIEW");
    findings.push("approval read failed — approval exposure UNKNOWN this call.");
  }

  const degraded = [delR, apprR, spendR].some((r) => r.status === "rejected");
  return {
    wallet,
    decision: verdict, // GO | REVIEW | STOP
    ...(degraded ? { degraded: true } : {}),
    vectors, // delegation | spendPermissions | approvals — each the underlying endpoint's result
    findings,
    recommendation:
      verdict === "STOP"
        ? "Act now — at least one vector can drain this wallet (hostile delegate, unbounded spend permission, or unlimited approval). Address the findings before funding it further."
        : verdict === "REVIEW"
          ? "Review — a vector warrants a look or could not be fully read. Nothing confirmed critical, but do not treat as fully clear."
          : "No drain vector found across 7702 delegation, Base Account spend permissions, and ERC-20 approvals. The agent-era surfaces are clear right now (they can change the next block).",
    note: "One verdict across the three ways an agent wallet gets drained: EIP-7702 delegation (total takeover), Base Account spend permissions, and ERC-20 approvals. Composes wallet-delegation + spend-audit + approval-advisor; drill into vectors for each. A vector that could not be read is 'unknown', never clear. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
