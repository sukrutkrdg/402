/**
 * agent-credit-score — Onchain Agent FICO & Autonomous Credit Scoring Engine.
 *
 * Evaluates an autonomous AI agent's wallet or smart contract on Base to determine:
 * 1. FICO-style Agent Credit Score (300 to 850)
 * 2. Trust Tier (AAA, AA, A, B, C, F)
 * 3. Postpaid Micro-Credit Limit (for zero-latency batch API settlement)
 * 4. Ethereum Attestation Service (EAS) qualification
 * 5. Default risk & onchain financial health
 *
 * Monetization model:
 * - Direct query fee: $0.04 USDC per credit check (used by DEXes, lending pools, counterparties)
 * - Financing spread: 2.5% premium on postpaid credit settlement
 * - Attestation certification fee: $1.00 USDC for onchain EAS Badge minting
 */

import "server-only";
import { createPublicClient, formatEther, formatUnits, getAddress, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { decisionReceipt } from "./envelope";

const client = createPublicClient({
  chain: base,
  transport: baseTransport(8000),
});

// Base USDC contract
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

export interface AgentCreditScoreResult {
  address: string;
  creditScore: number; // 300 - 850
  ratingTier: "AAA" | "AA" | "A" | "B" | "C" | "F";
  status: "PRIME" | "ESTABLISHED" | "EMERGING" | "PROBATIONARY" | "HIGH_RISK";
  postpaidCreditLimitUsd: number;
  financingSpreadPct: number;
  easAttestationEligible: boolean;
  verdict: string;
  metrics: {
    txCount: number;
    ethBalance: string;
    usdcBalance: string;
    isSmartContract: boolean;
    contractSize: number;
    activityTier: string;
    estimatedAgeCategory: string;
  };
  factors: {
    positive: string[];
    risk: string[];
  };
  terms: {
    settlementCycle: string;
    repaymentGracePeriodHours: number;
    gasSavingsMultiplier: string;
  };
}

export async function agentCreditScore(params: Record<string, string>) {
  const rawAddr = (params.address || params.agent || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(rawAddr)) {
    throw new Error("Provide a valid 0x… agent wallet or contract address");
  }
  const address = getAddress(rawAddr) as Address;

  // 1. Onchain checks in parallel: nonce/txCount, ETH balance, USDC balance, bytecode
  const [nonceRes, ethBalRes, codeRes, usdcBalRes] = await Promise.allSettled([
    client.getTransactionCount({ address }),
    client.getBalance({ address }),
    client.getBytecode({ address }),
    client.readContract({
      address: BASE_USDC,
      abi: [
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ type: "address" }],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "balanceOf",
      args: [address],
    }),
  ]);

  const txCount = nonceRes.status === "fulfilled" ? Number(nonceRes.value) : 0;
  const ethBalanceWei = ethBalRes.status === "fulfilled" ? ethBalRes.value : 0n;
  const ethBalance = Number(formatEther(ethBalanceWei));
  const bytecode = codeRes.status === "fulfilled" ? codeRes.value : undefined;
  const isSmartContract = Boolean(bytecode && bytecode.length > 2);
  const contractSize = bytecode ? (bytecode.length - 2) / 2 : 0;

  let usdcBalance = 0;
  if (usdcBalRes.status === "fulfilled" && typeof usdcBalRes.value === "bigint") {
    usdcBalance = Number(formatUnits(usdcBalRes.value, 6));
  }

  // 2. FICO-style algorithmic scoring (Base baseline: 300 - 850)
  let score = 300;
  const positive: string[] = [];
  const risk: string[] = [];

  // A. Transaction Volume & History Weight (max +220 pts)
  if (txCount > 500) {
    score += 220;
    positive.push(`High transaction frequency (${txCount} onchain txs)`);
  } else if (txCount > 100) {
    score += 170;
    positive.push(`Substantial activity record (${txCount} txs)`);
  } else if (txCount > 25) {
    score += 110;
    positive.push(`Consistent onchain history (${txCount} txs)`);
  } else if (txCount > 5) {
    score += 60;
    positive.push(`Active transaction trail (${txCount} txs)`);
  } else {
    score += 15;
    risk.push(`Fresh or low-activity wallet (${txCount} txs)`);
  }

  // B. Reserve & Solvency Weight (max +180 pts)
  const totalLiquidityUsd = ethBalance * 2600 + usdcBalance;
  if (totalLiquidityUsd > 10000) {
    score += 180;
    positive.push(`Institutional reserves ($${totalLiquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} USD liquidity)`);
  } else if (totalLiquidityUsd > 1000) {
    score += 130;
    positive.push(`Strong operating capital ($${totalLiquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} USD)`);
  } else if (totalLiquidityUsd > 100) {
    score += 80;
    positive.push(`Sufficient working balance ($${totalLiquidityUsd.toFixed(2)} USD)`);
  } else if (totalLiquidityUsd > 10) {
    score += 35;
  } else {
    risk.push("Near-zero liquid reserve balance (< $10 USD)");
  }

  // C. Architecture & Automation Capabilities (max +150 pts)
  if (isSmartContract) {
    score += 100;
    positive.push(`Smart Contract agent execution environment (${contractSize} bytes code)`);
  } else {
    // EOA with active funds
    score += 60;
  }

  // Base network gas readiness
  if (ethBalance >= 0.005) {
    score += 50;
    positive.push(`Adequate native gas buffer (${ethBalance.toFixed(4)} ETH on Base)`);
  } else {
    risk.push("Low ETH gas reserve on Base (< 0.005 ETH)");
  }

  score = Math.max(300, Math.min(850, Math.round(score)));

  // Tier determination
  let ratingTier: "AAA" | "AA" | "A" | "B" | "C" | "F" = "F";
  let status: "PRIME" | "ESTABLISHED" | "EMERGING" | "PROBATIONARY" | "HIGH_RISK" = "HIGH_RISK";
  let postpaidCreditLimitUsd = 0;
  let easAttestationEligible = false;

  if (score >= 760) {
    ratingTier = "AAA";
    status = "PRIME";
    postpaidCreditLimitUsd = 100.0;
    easAttestationEligible = true;
  } else if (score >= 700) {
    ratingTier = "AA";
    status = "ESTABLISHED";
    postpaidCreditLimitUsd = 50.0;
    easAttestationEligible = true;
  } else if (score >= 630) {
    ratingTier = "A";
    status = "ESTABLISHED";
    postpaidCreditLimitUsd = 20.0;
    easAttestationEligible = true;
  } else if (score >= 560) {
    ratingTier = "B";
    status = "EMERGING";
    postpaidCreditLimitUsd = 5.0;
    easAttestationEligible = false;
  } else if (score >= 460) {
    ratingTier = "C";
    status = "PROBATIONARY";
    postpaidCreditLimitUsd = 1.0;
    easAttestationEligible = false;
  } else {
    ratingTier = "F";
    status = "HIGH_RISK";
    postpaidCreditLimitUsd = 0.0;
    easAttestationEligible = false;
  }

  const verdict =
    postpaidCreditLimitUsd > 0
      ? `Approved for Tier ${ratingTier} autonomous credit with $${postpaidCreditLimitUsd.toFixed(2)} USD line.`
      : `Prepaid only. Insufficient onchain transaction history for credit line.`;

  const result: AgentCreditScoreResult = {
    address,
    creditScore: score,
    ratingTier,
    status,
    postpaidCreditLimitUsd,
    financingSpreadPct: 2.5,
    easAttestationEligible,
    verdict,
    metrics: {
      txCount,
      ethBalance: `${ethBalance.toFixed(4)} ETH`,
      usdcBalance: `$${usdcBalance.toFixed(2)} USDC`,
      isSmartContract,
      contractSize,
      activityTier: txCount > 100 ? "HIGH_FREQUENCY" : txCount > 10 ? "MODERATE" : "SPARSE",
      estimatedAgeCategory: txCount > 200 ? "ESTABLISHED_OPERATOR" : txCount > 20 ? "DEVELOPING" : "NEWBORN",
    },
    factors: {
      positive,
      risk,
    },
    terms: {
      settlementCycle: "Daily or upon reaching credit limit",
      repaymentGracePeriodHours: 24,
      gasSavingsMultiplier: "Up to 50x gas efficiency via batched settlement",
    },
  };

  return {
    address,
    creditScore: score,
    ratingTier,
    postpaidCreditLimitUsd,
    recommendation: verdict,
    data: result,
    receipt: decisionReceipt({
      endpoint: "agent-credit-score",
      params: { address },
      degraded: false,
    }),
    checkedAt: new Date().toISOString(),
  };
}
