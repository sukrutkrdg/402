import type { ServiceDef } from "./types";
import { rhStockVerify } from "../rh-services";

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
    params: [{ name: "address", label: "Robinhood Chain token address", placeholder: "e.g. 0xaF3D76…93f9 (AAPL)", required: true }],
    handler: rhStockVerify,
  },
];
