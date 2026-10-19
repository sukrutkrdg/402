import { walletSummary } from "./wallet-history";

export async function walletSybilScore(params: Record<string, string>) {
  const address = params.address;

  if (!address) {
    throw new Error("Missing wallet address");
  }

  // Sybil Score uses wallet history to heuristically assign a risk score.
  const summary = await walletSummary({ address });

  let sybilScore = 0;
  let riskString = "low";

  // Heuristic 1: Age
  if (summary.ageDays !== null && summary.ageDays < 7) {
    sybilScore += 40; // High risk for very new wallets
  } else if (summary.ageDays !== null && summary.ageDays < 30) {
    sybilScore += 20;
  }

  // Heuristic 2: Transaction Count
  const txCount = summary.outgoingTxCount ?? 0;
  if (txCount < 5) {
    sybilScore += 30; // Very few transactions typical of burner/bot accounts
  } else if (txCount < 20) {
    sybilScore += 10;
  } else if (txCount > 1000) {
    sybilScore += 20; // Extremely high transaction count could indicate bot activity
  }

  // Assign risk category based on score
  if (sybilScore >= 60) {
    riskString = "high";
  } else if (sybilScore >= 30) {
    riskString = "moderate";
  }

  return {
    address,
    sybil_score: sybilScore,
    risk: riskString,
    wallet_age_days: summary.ageDays,
    tx_count: txCount,
    note: "Sybil score is a heuristic based on wallet age and transaction count. High scores suggest bot or burner wallet behavior."
  };
}
