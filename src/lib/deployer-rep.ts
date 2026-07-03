/**
 * Deployer Reputation — "who created this token, and can you trust them?"
 *
 * The forensics layer others skip: a token is only as trustworthy as its
 * deployer. This reads the creator from on-chain security data, then profiles the
 * creator wallet (age, activity, balance) and combines it with how much of supply
 * the creator still holds and whether ownership is renounced — into a single
 * reputation read. Free upstreams (GoPlus + Base RPC).
 */

import "server-only";
import { tokenRisk, addressIntel } from "./onchain";

interface Security {
  creatorAddress?: string | null;
  creatorPct?: number | null;
  holderCount?: number | null;
}
interface Ownership {
  owner?: string | null;
  renounced?: boolean | null;
}
interface RiskShape {
  riskScore?: number;
  riskLevel?: string;
  flags?: string[];
  ownership?: Ownership;
  security?: Security;
}
interface ProfileShape {
  type?: string;
  txCount?: number;
  ethBalance?: string;
  activity?: string;
}

export async function deployerReputation(params: Record<string, string>) {
  const token = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("Provide a valid 0x… token contract address");

  // tokenRisk throws (pre-settlement) if the token can't be read at all.
  const risk = (await tokenRisk({ address: token })) as RiskShape;
  const creator = risk.security?.creatorAddress ?? null;
  const creatorPct = typeof risk.security?.creatorPct === "number" ? risk.security.creatorPct : null;
  const renounced = risk.ownership?.renounced ?? null;

  // Profile the creator wallet (best-effort — a fresh creator often has almost
  // no history, which is itself the signal).
  let profile: ProfileShape | null = null;
  if (creator && /^0x[0-9a-fA-F]{40}$/.test(creator)) {
    try {
      profile = (await addressIntel({ address: creator })) as ProfileShape;
    } catch {
      profile = null;
    }
  }

  const signals: string[] = [];
  let score = 50; // neutral baseline

  const txCount = profile?.txCount ?? null;
  if (txCount !== null) {
    if (txCount === 0) {
      score -= 25;
      signals.push("Creator wallet has zero transaction history (fresh/throwaway).");
    } else if (txCount < 10) {
      score -= 12;
      signals.push("Creator wallet has very little history.");
    } else if (txCount >= 1000) {
      score += 12;
      signals.push("Creator wallet is well-established (high activity).");
    } else {
      score += 4;
    }
  }

  if (creatorPct !== null) {
    if (creatorPct >= 20) {
      score -= 20;
      signals.push(`Creator still holds ${creatorPct}% of supply — can dump on holders.`);
    } else if (creatorPct >= 5) {
      score -= 8;
      signals.push(`Creator holds ${creatorPct}% of supply.`);
    } else {
      score += 6;
      signals.push("Creator holds little or none of the supply.");
    }
  }

  if (renounced === true) {
    score += 12;
    signals.push("Ownership is renounced — the creator can't change the contract.");
  } else if (renounced === false) {
    score -= 10;
    signals.push("Ownership is NOT renounced — the creator retains control.");
  }

  if ((risk.flags || []).length > 0) {
    score -= Math.min(20, (risk.flags || []).length * 4);
    signals.push(`Token itself carries risk flags: ${(risk.flags || []).slice(0, 6).join(", ")}.`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const reputation = score >= 70 ? "trusted" : score >= 50 ? "neutral" : score >= 30 ? "caution" : "high_risk";

  return {
    token,
    creator,
    creatorHoldingPct: creatorPct,
    ownershipRenounced: renounced,
    creatorProfile: profile
      ? { type: profile.type ?? null, txCount: profile.txCount ?? null, ethBalance: profile.ethBalance ?? null, activity: profile.activity ?? null }
      : null,
    reputationScore: score, // 0-100, higher = more trustworthy
    reputation, // trusted | neutral | caution | high_risk
    signals,
    recommendation:
      reputation === "high_risk"
        ? "Deployer profile is high-risk (fresh wallet and/or large creator holdings, no renounce). Treat the token as guilty until proven otherwise."
        : reputation === "caution"
          ? "Deployer shows caution signals — verify holdings and ownership before sizing up."
          : reputation === "trusted"
            ? "Deployer profile looks established and low-control."
            : "Deployer profile is unremarkable — combine with token-level checks.",
    note: "Creator identity from on-chain security data; profile from Base RPC. A fresh creator with large holdings and no renounce is the classic rug setup. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
