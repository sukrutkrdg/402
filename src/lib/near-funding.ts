/**
 * What discovery surfaces tell an agent from the NEAR ecosystem about paying us.
 *
 * One source so llms.txt, the agent card and /agents cannot drift apart. The
 * x402 challenge itself is Base-only and stays that way (see config.ts); this
 * only describes the two ways a NEAR agent reaches it.
 */

export function nearCreditsOn(): boolean {
  return process.env.ENABLE_NEAR_CREDITS === "true";
}

export function nearFunding(site: string) {
  const chainSignatures = {
    how: "NEAR Chain Signatures",
    summary:
      "A NEAR account can control an EVM address through Chain Signatures and sign the x402 payment (EIP-3009 USDC authorization on Base, eip155:8453) directly. Nothing NEAR-specific on our side: it is the standard x402 flow, the payer just signs through the NEAR MPC signer. The derived address needs USDC on Base; gas is paid by the facilitator.",
  };
  if (!nearCreditsOn()) return { chainSignatures };
  return {
    chainSignatures,
    nearIntentsCredits: {
      how: "NEAR Intents (1Click) → prepaid credits",
      summary:
        "No USDC on Base? Buy a credit pack with any asset NEAR Intents routes (NEAR, USDC on NEAR, BTC, SOL, …). It is swapped to USDC on Base for us; you get an x-credit-token that works on every paid endpoint with no per-call signature.",
      start: `${site}/api/credits/near/quote`,
    },
  };
}

/**
 * One sentence for surfaces that tell an agent how to get a credit token (MCP
 * server card, manifests): where to buy it when your money is on NEAR. Empty
 * when the rail is off, so no surface advertises a path that 404s.
 */
export function nearCreditHint(site: string): string {
  return nearCreditsOn()
    ? ` No USDC on Base? Buy the token with USDC, USDT or NEAR on NEAR via NEAR Intents at ${site}/credits (agents: POST ${site}/api/credits/near/quote).`
    : "";
}

/** Plain-text block for llms.txt. */
export function nearFundingLines(site: string): string[] {
  const f = nearFunding(site);
  const lines = [
    "## Agents on NEAR",
    `- ${f.chainSignatures.how}: ${f.chainSignatures.summary}`,
  ];
  if ("nearIntentsCredits" in f && f.nearIntentsCredits) {
    lines.push(
      `- ${f.nearIntentsCredits.how}: ${f.nearIntentsCredits.summary} Start: GET ${f.nearIntentsCredits.start} (instructions), then POST it { tier, originAsset, refundTo }.`,
    );
  }
  return lines;
}
