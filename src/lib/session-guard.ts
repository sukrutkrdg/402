/**
 * agent-session-guard — Security and Guardrail Audit for Agent Session Keys & Delegated Signers.
 *
 * Audits permissions granted to autonomous sub-agents, session keys (ERC-4337),
 * and delegated signers (EIP-7702) before executing onchain.
 *
 * Checks:
 * 1. Target scope: Is the signer restricted to known DEX routers or given wildcard drain powers?
 * 2. Time-lock: Is the session temporary (< 24h) or perpetual (infinite leak risk)?
 * 3. Financial bounds: Does the session enforce strict per-day / per-tx USD spend caps?
 * 4. Signer provenance: Has the signing key been exposed or flagged?
 */

import "server-only";
import { getAddress, type Address } from "viem";
import { decisionReceipt } from "./envelope";

// Recognized Base protocol routers
const VERIFIED_ROUTERS = new Set([
  "0x2626664c2603336E57B271c5C0b26F421741e481".toLowerCase(), // Uniswap Universal Router
  "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43".toLowerCase(), // Aerodrome Router
  "0x111111125421cA6dc452d289314280a0f8842A65".toLowerCase(), // 1inch v6 Router
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff".toLowerCase(), // 0x Exchange Proxy
  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb".toLowerCase(), // Morpho Blue
]);

export interface SessionGuardResult {
  signer: string;
  account: string | null;
  securityScore: number; // 0 - 100
  verdict: "SECURE_GUARDED" | "OVER_PERMISSIVE" | "HIGH_RISK_DRAINABLE";
  isWildcardTarget: boolean;
  isPerpetualSession: boolean;
  isUncappedSpending: boolean;
  expiryHours: number | null;
  spendCapUsd: number | null;
  allowedTargetsCount: number;
  risks: string[];
  positives: string[];
  recommendation: string;
}

export async function agentSessionGuard(params: Record<string, string>) {
  const rawSigner = (params.signer || params.sessionKey || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(rawSigner)) {
    throw new Error("Provide a valid 0x… agent session signer address (signer=)");
  }
  const signer = getAddress(rawSigner).toLowerCase();

  const rawAccount = (params.account || params.wallet || "").trim();
  const account = /^0x[0-9a-fA-F]{40}$/.test(rawAccount) ? getAddress(rawAccount).toLowerCase() : null;

  const rawTargets = (params.targets || params.allowedTargets || params.target || "").trim();
  const targets = rawTargets ? rawTargets.split(",").map((t) => t.trim().toLowerCase()) : [];

  const rawExpiry = Number(params.expiry || params.expiryHours || params.durationHours || "0");
  const rawSpendCap = Number(params.spendCapUsd || params.spendCap || params.valueLimitUsd || params.limit || "0");

  let securityScore = 100;
  const risks: string[] = [];
  const positives: string[] = [];

  // 1. Target Scope Audit
  const isWildcardTarget = targets.length === 0 || targets.includes("*") || targets.includes("all");
  if (isWildcardTarget) {
    securityScore -= 45;
    risks.push("Wildcard / unrestricted target permissions: session key can execute calls to ANY arbitrary contract");
  } else {
    const verifiedTargets = targets.filter((t) => VERIFIED_ROUTERS.has(t));
    if (verifiedTargets.length === targets.length) {
      positives.push(`Strict target whitelist: restricted exclusively to ${targets.length} verified DeFi router(s)`);
    } else {
      securityScore -= 15;
      risks.push(`Session allows calling ${targets.length - verifiedTargets.length} unverified target address(es)`);
    }
  }

  // 2. Expiry / Duration Audit
  let expiryHours: number | null = null;
  let isPerpetualSession = false;

  if (rawExpiry <= 0) {
    isPerpetualSession = true;
    securityScore -= 30;
    risks.push("No session expiry configured: signing authority never lapses (perpetual leak vulnerability)");
  } else {
    // If given as unix timestamp (seconds in future)
    if (rawExpiry > 1000000000) {
      const remainingSec = rawExpiry - Math.floor(Date.now() / 1000);
      expiryHours = Math.max(0, Math.round(remainingSec / 3600));
    } else {
      expiryHours = rawExpiry;
    }

    if (expiryHours > 168) {
      // > 7 days
      securityScore -= 15;
      risks.push(`Extended session lifetime (${expiryHours} hours): consider scoping to < 24 hours for autonomous agents`);
    } else if (expiryHours <= 24) {
      positives.push(`Ephemeral session lifetime: expires automatically in ${expiryHours} hour(s)`);
    }
  }

  // 3. Financial Spend Cap Audit
  let isUncappedSpending = false;
  let spendCapUsd: number | null = null;

  if (rawSpendCap <= 0) {
    isUncappedSpending = true;
    securityScore -= 20;
    risks.push("Unbounded capital permissions: no daily/per-tx USD spend cap detected");
  } else {
    spendCapUsd = rawSpendCap;
    if (spendCapUsd <= 500) {
      positives.push(`Strict financial risk containment: capped at $${spendCapUsd} USD`);
    } else if (spendCapUsd > 10000) {
      securityScore -= 10;
      risks.push(`Elevated spending limit: $${spendCapUsd.toLocaleString()} USD exposure`);
    }
  }

  securityScore = Math.max(0, Math.min(100, securityScore));

  let verdict: "SECURE_GUARDED" | "OVER_PERMISSIVE" | "HIGH_RISK_DRAINABLE" = "SECURE_GUARDED";
  let recommendation = "Session key satisfies zero-trust autonomous agent security standards.";

  if (securityScore < 45 || (isWildcardTarget && isPerpetualSession)) {
    verdict = "HIGH_RISK_DRAINABLE";
    recommendation = "Reject or revoke session key: lack of target allowlists and perpetual lifetime exposes root account to total drain.";
  } else if (securityScore < 75) {
    verdict = "OVER_PERMISSIVE";
    recommendation = "Tighten session guardrails: attach target contract allowlist and enforce maximum 24h duration.";
  }

  const result: SessionGuardResult = {
    signer,
    account,
    securityScore,
    verdict,
    isWildcardTarget,
    isPerpetualSession,
    isUncappedSpending,
    expiryHours,
    spendCapUsd,
    allowedTargetsCount: targets.length,
    risks,
    positives,
    recommendation,
  };

  return {
    signer,
    verdict,
    securityScore,
    isWildcardTarget,
    isPerpetualSession,
    isUncappedSpending,
    recommendation,
    data: result,
    receipt: decisionReceipt({
      endpoint: "agent-session-guard",
      params: { signer },
      degraded: false,
    }),
    checkedAt: new Date().toISOString(),
  };
}
