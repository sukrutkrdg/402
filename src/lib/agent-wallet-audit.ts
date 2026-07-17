/**
 * Agent Wallet Audit — every way funds can leave a Base wallet WITHOUT a fresh
 * signature, in one call.
 *
 * An agent's wallet can be drained through two distinct authority surfaces:
 *   1. ERC-20 approvals — a spender you once approved can pull the token (the
 *      classic drain vector). Read via approval-advisor.
 *   2. Base Account spend permissions — the agent-era primitive: a scoped,
 *      recurring allowance an app/agent can pull every period, no signature per
 *      pull. Read via spend-audit.
 *
 * ERC-20 approval tools miss #2; spend-permission tools miss #1. This is the only
 * combined "drain surface" audit — a composite no single competitor offers,
 * because no one else has both pieces. Deterministic, no LLM.
 */

import "server-only";
import { approvalAdvisor } from "./approval-advisor";
import { spendAudit } from "./spend-audit";
import { finish } from "./envelope";

interface ApprovalResult {
  totalUsdAtRisk?: number;
  highPriorityCount?: number;
  revokeQueue?: unknown[];
  recommendation?: string;
}
interface SpendResult {
  activeCount?: number;
  highRiskCount?: number;
  verdict?: string;
  permissions?: unknown[];
  recommendation?: string;
  degraded?: boolean;
}

export async function agentWalletAudit(params: Record<string, string>) {
  const wallet = (params.wallet || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("Provide a valid 0x… wallet address (wallet=)");

  const [apprR, spendR] = await Promise.allSettled([
    approvalAdvisor({ address: wallet }),
    spendAudit({ wallet }),
  ]);

  const appr = apprR.status === "fulfilled" ? (apprR.value as ApprovalResult) : null;
  const spend = spendR.status === "fulfilled" ? (spendR.value as SpendResult) : null;

  // A failed source can't read as "no exposure" — surface it as degraded so a
  // clean verdict is never falsely given.
  const approvalsUnavailable = appr === null;
  const spendUnavailable = spend === null;
  const degraded = approvalsUnavailable || spendUnavailable || spend?.degraded === true;

  const approvalRisk = {
    available: !approvalsUnavailable,
    count: (appr?.revokeQueue?.length ?? 0),
    highPriorityCount: appr?.highPriorityCount ?? 0,
    usdAtRisk: appr?.totalUsdAtRisk ?? 0,
    revokeQueue: appr?.revokeQueue ?? [],
  };
  const spendRisk = {
    available: !spendUnavailable,
    activeCount: spend?.activeCount ?? 0,
    highRiskCount: spend?.highRiskCount ?? 0,
    verdict: spend?.verdict ?? null,
    permissions: spend?.permissions ?? [],
  };

  const totalGrants = approvalRisk.count + spendRisk.activeCount;
  const highRisk = approvalRisk.highPriorityCount + spendRisk.highRiskCount;

  // Unified verdict across both surfaces.
  const verdict = highRisk > 0
    ? "action_required"
    : totalGrants > 0
      ? "review"
      : degraded
        ? "unknown"
        : "clean";

  const recommendation =
    verdict === "action_required"
      ? `⚠️ ${highRisk} high-risk fund-movement grant(s) across ERC-20 approvals and Base Account spend permissions — revoke any you don't recognize. Each lets a spender move funds with no fresh signature from you.`
      : verdict === "review"
        ? `${totalGrants} active grant(s) can move funds without a new signature (${approvalRisk.count} ERC-20 approval(s), ${spendRisk.activeCount} spend permission(s)). Confirm each is one you intend to keep.`
        : verdict === "unknown"
          ? "One or both authority sources could not be read this call — do NOT treat this wallet as clean. Re-check shortly."
          : "No standing ERC-20 approvals or Base Account spend permissions can move funds from this wallet without a fresh signature.";

  return finish({
    wallet,
    verdict, // action_required | review | clean | unknown
    ...(degraded ? { degraded: true } : {}),
    totalGrants,
    highRiskGrants: highRisk,
    approvals: approvalRisk, // ERC-20 allowance surface (+ revokeQueue to act on)
    spendPermissions: spendRisk, // Base Account spend-permission surface
    recommendation,
    note: "The full fund-movement authority on a Base wallet: ERC-20 approvals (approval-advisor) + Base Account spend permissions (spend-audit) in one verdict — the drain surface ERC-20-only and spend-permission-only tools each miss half of. Revoke ERC-20 approvals from the revokeQueue; revoke spend permissions in the Base Account app. Not financial advice.",
  });
}
