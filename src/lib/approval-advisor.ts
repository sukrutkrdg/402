/**
 * Approval Exposure + Revoke Advisor — "which of your approvals could drain you,
 * and in what order should you revoke them."
 *
 * A wallet's active token approvals are the #1 drain vector. This takes the raw
 * approvals, ranks them by USD-at-risk and danger (unlimited allowance to an
 * unlabelled/unverified spender), and returns a prioritised revoke list an agent
 * can act on. Built on our token-approvals data with the analysis on top.
 *
 * Metered upstream (Covalent) → registered paid-only.
 */

import "server-only";
import { tokenApprovals } from "./covalent";

interface Spender {
  spender?: string | null;
  label?: string | null;
  allowance?: string | null;
  usdAtRisk?: number | null;
  riskFactor?: string | null;
}
interface Approval {
  token?: string | null;
  tokenAddress?: string | null;
  usdAtRisk?: number | null;
  spenders?: Spender[];
}

const UNLIMITED_HINTS = [/^0x[fF]{40,}/, /115792089237316195423570985008687907853269984665640564039457584007913129639935/];
function isUnlimited(allowance?: string | null): boolean {
  if (!allowance) return false;
  const a = String(allowance);
  return UNLIMITED_HINTS.some((re) => re.test(a)) || a.length >= 40; // very large ≈ unlimited
}

export async function approvalAdvisor(params: Record<string, string>) {
  const raw = (await tokenApprovals(params)) as {
    address?: string;
    approvalCount?: number;
    approvals?: Approval[];
    totalUsdAtRisk?: number;
  };
  const approvals = raw.approvals ?? [];

  // Flatten to per-spender rows with a danger score.
  const items = approvals.flatMap((a) =>
    (a.spenders ?? []).map((s) => {
      const unlimited = isUnlimited(s.allowance);
      const unlabelled = !s.label || s.label.trim() === "";
      const usd = typeof s.usdAtRisk === "number" ? s.usdAtRisk : a.usdAtRisk ?? 0;
      // Danger: USD at risk, amplified by unlimited allowance to an unlabelled spender.
      let danger = usd;
      if (unlimited) danger *= 2;
      if (unlabelled) danger *= 1.5;
      const reasons: string[] = [];
      if (unlimited) reasons.push("unlimited allowance");
      if (unlabelled) reasons.push("unlabelled/unknown spender");
      if (s.riskFactor) reasons.push(String(s.riskFactor));
      return {
        token: a.token ?? null,
        tokenAddress: a.tokenAddress ?? null,
        spender: s.spender ?? null,
        spenderLabel: s.label ?? null,
        unlimited,
        usdAtRisk: +Number(usd).toFixed(2),
        priority: unlimited && unlabelled && usd > 0 ? "high" : usd > 100 || unlimited ? "medium" : "low",
        reasons,
        dangerScore: +danger.toFixed(2),
      };
    }),
  );

  items.sort((a, b) => b.dangerScore - a.dangerScore);

  const highPriority = items.filter((i) => i.priority === "high");
  const totalUsdAtRisk = raw.totalUsdAtRisk ?? +items.reduce((s, i) => s + i.usdAtRisk, 0).toFixed(2);

  return {
    address: raw.address ?? params.address,
    approvalCount: raw.approvalCount ?? items.length,
    totalUsdAtRisk,
    highPriorityCount: highPriority.length,
    revokeQueue: items, // sorted worst-first — revoke top-down
    recommendation:
      highPriority.length > 0
        ? `Revoke the ${highPriority.length} high-priority approval(s) first — unlimited allowances to unknown spenders with real USD at risk.`
        : totalUsdAtRisk > 0
          ? "No critical approvals, but revoke anything you no longer use to shrink the attack surface."
          : "No meaningful approval exposure detected.",
    note: "Revoke at revoke.cash or by setting the allowance to 0. Prioritised by USD-at-risk × unlimited × unlabelled. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
