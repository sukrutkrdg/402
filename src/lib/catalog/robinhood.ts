import type { ServiceDef } from "./types";
import { rhStockVerify, rhStockPrice, rhStockPeg, rhStockBundle } from "../rh-services";

const RH_ADDR = [{ name: "address", label: "Robinhood Chain token address", placeholder: "e.g. 0xaF3D76…93f9 (AAPL)", required: true }];

/**
 * Robinhood Chain (chain 4663) services — an isolated EVM chain arm, settled in
 * USDC on Base/Solana over the existing x402 rail (like the NEAR/Solana/Arbitrum
 * arms). Reads Robinhood Chain RPC. No other chain file imports anything here.
 */
export const ROBINHOOD_SERVICES: ServiceDef[] = [
  {
    id: "rh-stock-verify",
    name: "Robinhood Stock Verify",
    tagline: "Authentic Robinhood tokenized stock, or a ticker-wearing impersonator?",
    description:
      "🆕 For Robinhood Chain (chain 4663, ~200 tokenized stocks). Robinhood-issued stocks aren't rugs — the real risk is a fake token wearing a real ticker. One call verifies a token is an AUTHENTIC Robinhood issuance by matching its on-chain bytecode against the official Stock Token (all genuine ones are byte-identical beacon proxies), and returns the ticker, name, decimals and supply. AUTHENTIC / UNVERIFIED / UNKNOWN. Unreadable chain → not charged. Not advice.",
    price: "$0.02",
    icon: "🏛️",
    category: "Robinhood",
    params: RH_ADDR,
    handler: rhStockVerify,
  },
  {
    id: "rh-stock-price",
    name: "Robinhood Stock Price",
    tagline: "On-chain price, liquidity & 24h volume of a tokenized stock",
    description:
      "🆕 The on-chain tradeable price of a Robinhood Chain tokenized stock (via GeckoTerminal) — USD price, pool depth (deep/moderate/thin) and 24h volume. Compare it to the real equity to spot a de-peg, or size a trade against the on-chain liquidity. No DEX price found → not charged. Not advice.",
    price: "$0.02",
    icon: "🏛️",
    category: "Robinhood",
    params: RH_ADDR,
    handler: rhStockPrice,
  },
  {
    id: "rh-stock-peg",
    name: "Robinhood Stock Peg",
    tagline: "Is the tokenized stock still tracking the real equity, or de-pegged?",
    description:
      "🆕 Does a Robinhood Chain tokenized stock still track the real stock it represents? Compares its on-chain DEX price to the real equity's last market price (by ticker) and returns the gap: IN_PEG / PREMIUM / DISCOUNT with the exact %. A wide gap = an arbitrage signal or a risk (thin pools, after-hours, stale). Unreadable price → not charged. Not advice.",
    price: "$0.03",
    icon: "🏛️",
    category: "Robinhood",
    params: RH_ADDR,
    handler: rhStockPeg,
  },
  {
    id: "rh-stock-bundle",
    name: "Robinhood Stock Bundle",
    tagline: "Authenticity + price + peg + liquidity for a tokenized stock, one call",
    description:
      "🆕 The whole Robinhood-stock read in one call: is it an AUTHENTIC Robinhood issuance (bytecode match), its on-chain price vs the real equity (IN_PEG / PREMIUM / DISCOUNT + %), liquidity, 24h volume and supply — plus the ticker and name. Fewer round-trips for an agent screening a tokenized stock before it trades. Unreadable chain → not charged. Not advice.",
    price: "$0.05",
    icon: "🏛️",
    category: "Robinhood",
    params: RH_ADDR,
    handler: rhStockBundle,
  },
];
