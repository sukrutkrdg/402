/**
 * pre-trade-bundle — All-in-one autonomous pre-trade evaluation.
 *
 * Combines 3 critical onchain checks into a single call with a single decision receipt:
 * 1. Honeypot & Contract Vulnerability (token-risk)
 * 2. Clanker Authenticity & Deployer Verification (clanker-token-audit)
 * 3. Base DEX Spread & Liquidity Arbitrage (base-dex-spread)
 *
 * Saves AI agents multiple round-trips and gas, returning a definitive GO/NO-GO verdict.
 */

import "server-only";
import { getAddress } from "viem";
import { decisionReceipt } from "./envelope";
import { clankerTokenAudit } from "./clanker-audit";
import { tokenRisk } from "./onchain";
import { baseDexSpread } from "./dex-spread";

export type PreTradeVerdict =
  | "SAFE_TO_TRADE"
  | "HIGH_RISK"
  | "BLOCKED_HONEYPOT"
  | "IMPERSONATOR_CLONE"
  | "ILLIQUID_SPREAD";

export interface PreTradeBundleResult {
  address: string;
  verdict: PreTradeVerdict;
  safetyScore: number; // 0 (worst) to 100 (safest)
  confidence: number;
  recommendation: "EXECUTE" | "REDUCE_SIZE" | "ABORT";
  summary: string;
  keyFindings: string[];
  checks: {
    clanker: {
      isOfficialClanker: boolean;
      version: string;
      isImpersonatorRisk: boolean;
      verdict: string;
    };
    security: {
      isHoneypot: boolean;
      sellTaxPct: number | null;
      riskScore: number;
    };
    liquidity: {
      spreadBps: number;
      bestBuyDex: string | null;
      bestSellDex: string | null;
      verdict: string;
    };
  };
  receipt?: Record<string, unknown>;
}

export async function preTradeBundle(params: Record<string, string>): Promise<PreTradeBundleResult> {
  const rawAddr = (params.address || params.token || params.tokenOut || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(rawAddr)) {
    throw new Error("Provide a valid 0x… Base token address (address=)");
  }
  const address = getAddress(rawAddr);
  const normalizedAddr = address.toLowerCase();

  // Execute all 3 checks in parallel with fault tolerance
  const [clankerRes, riskRes, dexRes] = await Promise.allSettled([
    clankerTokenAudit({ address: normalizedAddr }),
    tokenRisk({ address: normalizedAddr }),
    baseDexSpread({ token: normalizedAddr }),
  ]);

  const clanker = clankerRes.status === "fulfilled" ? (clankerRes.value as Record<string, any>) : null;
  const risk = riskRes.status === "fulfilled" ? (riskRes.value as Record<string, any>) : null;
  const dex = dexRes.status === "fulfilled" ? (dexRes.value as Record<string, any>) : null;

  // Extract Security Data
  const secData = (risk?.data?.security ?? risk?.security ?? {}) as {
    isHoneypot?: boolean;
    sellTaxPct?: number | null;
  };
  const isHoneypot = Boolean(secData.isHoneypot);
  const sellTaxPct = typeof secData.sellTaxPct === "number" ? secData.sellTaxPct : null;
  const rawRiskScore = typeof risk?.riskScore === "number" ? risk.riskScore : 50;

  // Extract Clanker Data
  const isOfficialClanker = Boolean(clanker?.data?.isOfficialClanker ?? clanker?.isOfficialClanker);
  const clankerVer = String(clanker?.data?.clankerVersion ?? clanker?.clankerVersion ?? "none");
  const isImpersonator = Boolean(clanker?.data?.isImpersonatorRisk ?? clanker?.isImpersonatorRisk);
  const clankerVerdict = String(clanker?.verdict ?? "STANDARD_TOKEN");

  // Extract DEX Spread Data
  const spreadBps = typeof dex?.spreadBps === "number" ? dex.spreadBps : 0;
  const bestBuyDex = dex?.bestBuyDex ? String(dex.bestBuyDex) : null;
  const bestSellDex = dex?.bestSellDex ? String(dex.bestSellDex) : null;
  const dexVerdict = String(dex?.verdict ?? "UNKNOWN");

  // Synthesize Safety Score (0 - 100)
  let score = 100;
  const findings: string[] = [];

  if (isHoneypot) {
    score -= 100;
    findings.push("CRITICAL: Token detected as honeypot (cannot sell)");
  } else {
    findings.push("Clean honeypot check (sell allowed)");
  }

  if (isImpersonator) {
    score -= 50;
    findings.push("WARNING: Token name/symbol impersonates Clanker deployment without official deployer");
  } else if (isOfficialClanker) {
    findings.push(`VERIFIED: Official Clanker autonomous deployer verified (${clankerVer})`);
  }

  if (sellTaxPct !== null && sellTaxPct > 10) {
    score -= Math.min(30, Math.round(sellTaxPct * 1.5));
    findings.push(`HIGH TAX: Excessive sell tax detected (${sellTaxPct}%)`);
  }

  if (dexVerdict === "NO_POOLS_FOUND") {
    score -= 30;
    findings.push("LOW LIQUIDITY: No active Uniswap v3 or Aerodrome liquidity pools found");
  } else if (spreadBps > 300) {
    score -= 20;
    findings.push(`HIGH SLIPPAGE: Elevated cross-DEX spread (${(spreadBps / 100).toFixed(2)}%)`);
  } else {
    findings.push(`LIQUID: Active multi-DEX liquidity available (Spread: ${(spreadBps / 100).toFixed(2)}%)`);
  }

  score = Math.max(0, Math.min(100, score));

  // Determine Overall Verdict
  let verdict: PreTradeVerdict;
  let recommendation: "EXECUTE" | "REDUCE_SIZE" | "ABORT";
  let summary: string;

  if (isHoneypot) {
    verdict = "BLOCKED_HONEYPOT";
    recommendation = "ABORT";
    summary = "DO NOT TRADE. The token contract was identified as a honeypot or non-sellable scam.";
  } else if (isImpersonator) {
    verdict = "IMPERSONATOR_CLONE";
    recommendation = "ABORT";
    summary = "UNSAFE. Contract mimics official Clanker agents but was not deployed by authentic factory.";
  } else if (score < 40) {
    verdict = "HIGH_RISK";
    recommendation = "ABORT";
    summary = "HIGH RISK. Elevated contract flags or extreme sell tax present.";
  } else if (score < 75 || dexVerdict === "NO_POOLS_FOUND" || spreadBps > 500) {
    verdict = "ILLIQUID_SPREAD";
    recommendation = "REDUCE_SIZE";
    summary = "CAUTION. Token is tradeable but has high cross-DEX slippage or shallow liquidity.";
  } else {
    verdict = "SAFE_TO_TRADE";
    recommendation = "EXECUTE";
    summary = "PASSED. Clean contract security, verified deployment lineage, and liquid DEX routing.";
  }

  const result: PreTradeBundleResult = {
    address: normalizedAddr,
    verdict,
    safetyScore: score,
    confidence: riskRes.status === "fulfilled" && dexRes.status === "fulfilled" ? 95 : 75,
    recommendation,
    summary,
    keyFindings: findings,
    checks: {
      clanker: {
        isOfficialClanker,
        version: clankerVer,
        isImpersonatorRisk: isImpersonator,
        verdict: clankerVerdict,
      },
      security: {
        isHoneypot,
        sellTaxPct,
        riskScore: rawRiskScore,
      },
      liquidity: {
        spreadBps,
        bestBuyDex,
        bestSellDex,
        verdict: dexVerdict,
      },
    },
  };

  const receipt = decisionReceipt({
    endpoint: "pre-trade-bundle",
    params: { address: normalizedAddr },
    degraded: !(riskRes.status === "fulfilled" && dexRes.status === "fulfilled"),
  });
  return {
    ...result,
    receipt: receipt as unknown as Record<string, unknown>,
  };
}
