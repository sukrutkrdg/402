import { walletPortfolio } from "./alchemy";

export async function treasuryHealth(params: Record<string, string>) {
  const address = params.address;

  if (!address) {
    throw new Error("Missing treasury address");
  }

  // Fetch real portfolio data
  const portfolio = await walletPortfolio({ address });

  let nativeUsd = 0;
  let stableUsd = 0;
  let totalUsd = 0;

  // Identify common stablecoins/wrapped ETH based on known list
  const isStable = (symbol: string) => /USDC|USDT|DAI|FRAX|WETH|ETH/i.test(symbol || "");

  if (portfolio.holdings && Array.isArray(portfolio.holdings)) {
    for (const token of portfolio.holdings) {
      const val = typeof token.usdValue === "number" ? token.usdValue : 0;
      totalUsd += val;

      if (isStable(token.symbol || "")) {
        stableUsd += val;
      } else {
        // We consider the rest as "native/other" tokens
        nativeUsd += val;
      }
    }
  }

  let nativePct = totalUsd > 0 ? (nativeUsd / totalUsd) * 100 : 0;
  let stablePct = totalUsd > 0 ? (stableUsd / totalUsd) * 100 : 0;

  // Default to 100% native if portfolio is completely empty (conservative fallback)
  if (totalUsd === 0) {
    nativePct = 100;
    stablePct = 0;
  }

  let healthString = "poor";

  if (stablePct > 50) {
    healthString = "excellent";
  } else if (stablePct > 20) {
    healthString = "fair";
  }

  return {
    treasury_address: address,
    native_token_pct: nativePct,
    stablecoin_pct: stablePct,
    total_value_usd: totalUsd,
    health: healthString,
    note: "Health is determined by the ratio of stable/liquid assets to illiquid/native token holdings."
  };
}
