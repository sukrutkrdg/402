import type { ServiceDef } from "./types";
import { arbTokenVerdict, arbSellability, arbTokenRisk } from "../arb-services";

/**
 * Arbitrum (chain 42161) services — an isolated EVM chain arm, settled in USDC on
 * Base or Solana over the existing x402 rail (like the NEAR/Solana arms). Reads
 * GoPlus token_security on 42161. No Base/NEAR/Solana file imports anything here;
 * the dependency arrow points one way (catalog/index → arbitrum).
 */
const ADDR_PARAM = [{ name: "address", label: "Arbitrum token address", placeholder: "e.g. 0x912CE5…E6548", required: true }];

export const ARBITRUM_SERVICES: ServiceDef[] = [
  {
    id: "arb-token-verdict",
    name: "Arbitrum Token Verdict",
    tagline: "One call → SAFE / CAUTION / AVOID for any Arbitrum token",
    description:
      "🆕 token-verdict for Arbitrum (chain 42161) — one call → SAFE / CAUTION / AVOID for any token: honeypot, buy/sell tax, mintable supply, owner powers (reclaim/hidden owner), pausable transfers, blacklist, upgradeable proxy, source verification, LP-lock and top-10 holder concentration, from GoPlus. Same output shape as the Base hero. An unreadable security check is UNKNOWN, not charged. Not advice.",
    price: "$0.03",
    icon: "🔵",
    category: "Arbitrum",
    params: ADDR_PARAM,
    handler: arbTokenVerdict,
  },
  {
    id: "arb-sellability",
    name: "Arbitrum Sellability / Honeypot",
    tagline: "Can you SELL it back, or is it a honeypot?",
    description:
      "Honeypot / can-you-sell check for any Arbitrum token (GoPlus): sellable or not, sell tax, and a HONEYPOT flag when the contract blocks selling. The check a sniper bot makes before buying. No GoPlus answer → not charged. Not advice.",
    price: "$0.02",
    icon: "🔵",
    category: "Arbitrum",
    params: ADDR_PARAM,
    handler: arbSellability,
  },
  {
    id: "arb-token-risk",
    name: "Arbitrum Token Risk Flags",
    tagline: "GoPlus risk flags (terminal + caution) with a low/medium/high level",
    description:
      "Every GoPlus risk flag for an Arbitrum token in one call — terminal (honeypot, can't-sell, self-destruct) and caution (tax, mintable, owner powers, pausable, blacklist, proxy, unverified, weak LP, concentration) — with a low/medium/high level. No GoPlus answer → not charged. Not advice.",
    price: "$0.02",
    icon: "🔵",
    category: "Arbitrum",
    params: ADDR_PARAM,
    handler: arbTokenRisk,
  },
];
