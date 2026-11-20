import type { ServiceDef } from "./types";
import { solTokenVerdict } from "../sol-token-verdict";
import {
  solPreTradeGate,
  solTokenRisk,
  solSellability,
  solLpCheck,
  solHolderConcentration,
  solPrice,
  solLiquidity,
  solPreTradeBundle,
  solNewPairs,
  solSafeLaunches,
} from "../sol-services";

/**
 * Solana (SPL) services — a parallel, isolated chain arm, settled in USDC on Base
 * over the existing x402 rail (exactly like the NEAR services). No Base/NEAR file
 * imports anything here; the dependency arrow points one way (catalog/index → solana).
 */
const MINT_PARAM = [{ name: "mint", label: "Solana SPL mint address", placeholder: "e.g. DezXAZ8z…pPB263", required: true }];

export const SOLANA_SERVICES: ServiceDef[] = [
  {
    id: "sol-token-verdict",
    name: "Solana Token Verdict",
    tagline: "One call → SAFE / CAUTION / AVOID for any Solana (SPL) token",
    description:
      "🆕 token-verdict for Solana — one call → SAFE / CAUTION / AVOID for any SPL mint: mint & freeze authority (the Solana seize/freeze analog), Token-2022 extensions (permanent-delegate seize, transfer-hook honeypot, non-transferable, frozen-by-default), Jupiter sellability (buy-but-not-sell = honeypot) and RugCheck LP-lock + concentration. Same output shape as the Base hero. An unrunnable gating read is UNKNOWN, not charged. Not advice.",
    price: "$0.03",
    icon: "◎",
    category: "Solana",
    params: MINT_PARAM,
    handler: solTokenVerdict,
  },
  {
    id: "sol-pre-trade-gate",
    name: "Solana Pre-Trade Gate",
    tagline: "GO / HOLD / STOP for any SPL token — the call every bot makes before it buys",
    description:
      "The one call a Solana trading agent makes before each buy: GO / HOLD / STOP for any SPL mint, with the reasons and a recommended max size. Distils the full safety stack (mint/freeze authority, Token-2022 seize extensions, Jupiter sellability, RugCheck LP-lock) into a single trade decision. STOP on any terminal flag (seize, honeypot, freeze-trap). Unverified mint is UNKNOWN, not charged. Not advice.",
    price: "$0.04",
    icon: "◎",
    category: "Solana",
    params: MINT_PARAM,
    handler: solPreTradeGate,
  },
  {
    id: "sol-token-risk",
    name: "Solana Token Risk Score",
    tagline: "RugCheck risk score (0–100) + the flags behind it",
    description:
      "A single risk score (0 = clean … 100 = max risk) for any SPL mint, with the danger flags and warnings behind it, from RugCheck. Low/medium/high band for a quick gate. If RugCheck does not answer, you are not charged. Not advice.",
    price: "$0.02",
    icon: "◎",
    category: "Solana",
    params: MINT_PARAM,
    handler: solTokenRisk,
  },
  {
    id: "sol-sellability",
    name: "Solana Sellability / Honeypot",
    tagline: "Can you SELL it back, or is it a honeypot?",
    description:
      "Probes a real sell route back to USDC (Jupiter) for any SPL mint: sellable or not, price impact, and a HONEYPOT flag when it's buyable but has no sell route AND an active freeze authority. The check sniper bots make before buying. Unreadable mint or no Jupiter answer → not charged. Not advice.",
    price: "$0.02",
    icon: "◎",
    category: "Solana",
    params: MINT_PARAM,
    handler: solSellability,
  },
  {
    id: "sol-lp-check",
    name: "Solana LP Lock Check",
    tagline: "How much liquidity is locked/burned — rug-pull setup detector",
    description:
      "What share of the liquidity pool is locked or burned for any SPL mint (via RugCheck): strong / partial / weak, with the locked percentage. Weak LP = the deployer can pull liquidity (classic rug). If RugCheck does not report LP, you are not charged. Not advice.",
    price: "$0.02",
    icon: "◎",
    category: "Solana",
    params: MINT_PARAM,
    handler: solLpCheck,
  },
  {
    id: "sol-holder-concentration",
    name: "Solana Holder Concentration",
    tagline: "Top-10 holder % — insider / bundle signal",
    description:
      "Share of supply held by the 10 largest accounts for any SPL mint (low/medium/high), plus the single largest holder, via getTokenLargestAccounts. A high number flags insider/bundle concentration — though the largest accounts can include the LP pool, a CEX or a burn address. Unreadable mint or no holder data → not charged. Not advice.",
    price: "$0.03",
    icon: "◎",
    category: "Solana",
    params: MINT_PARAM,
    handler: solHolderConcentration,
  },
  {
    id: "sol-price",
    name: "Solana Token Price",
    tagline: "Spot USD price from the deepest DEX pair",
    description:
      "Spot USD price for any SPL mint from the deepest DEX pair (DexScreener), with FDV and the number of pairs. No DEX price found → not charged. Not advice.",
    price: "$0.01",
    icon: "◎",
    category: "Solana",
    params: MINT_PARAM,
    handler: solPrice,
  },
  {
    id: "sol-pre-trade-bundle",
    name: "Solana Pre-Trade Bundle",
    tagline: "The whole Solana stack in one call — gate + safety + holders + market",
    description:
      "One call returns everything a Solana agent needs before a buy: a GO / HOLD / STOP gate, the full safety verdict (authorities, Token-2022 seize extensions, sellability, LP-lock), top-10 holder concentration, and market depth (price, liquidity, 24h volume). Fewer round-trips than calling each check. An unreadable gating read is UNKNOWN, not charged. Not advice.",
    price: "$0.05",
    icon: "◎",
    category: "Solana",
    params: MINT_PARAM,
    handler: solPreTradeBundle,
  },
  {
    id: "sol-new-pairs",
    name: "Solana New Pairs",
    tagline: "Freshly-created Solana pools (incl. pump.fun) — snipe, then verify",
    description:
      "The newest Solana DEX pools (via GeckoTerminal), each with its mint, age, liquidity, 24h volume and a pump.fun flag — the fresh-launch feed sniper bots watch. Optional: limit (1–30) and minLiquidityUsd to filter dust. New ≠ safe: pair it with sol-token-verdict before buying. No feed → not charged. Not advice.",
    price: "$0.02",
    icon: "◎",
    category: "Solana",
    params: [
      { name: "limit", label: "Max pools (1–30)", placeholder: "15", required: false },
      { name: "minLiquidityUsd", label: "Min liquidity USD", placeholder: "0", required: false },
    ],
    handler: solNewPairs,
  },
  {
    id: "sol-safe-launches",
    name: "Solana Safe Launches Feed",
    tagline: "Fresh pools + a built-in clean/risky/danger screen — poll it, skip the rugs",
    description:
      "The fresh-launch feed with a safety screen built in: the newest Solana pools (incl. pump.fun), each tagged clean / risky / danger from a fast mint-level check — mint & freeze authority renounced, and Token-2022 seize extensions (permanent-delegate, transfer-hook, non-transferable, frozen-by-default). Poll it to skip the obvious rugs, then run sol-pre-trade-gate on the ones you like. Optional: limit (1–20), minLiquidityUsd. No feed → not charged. Not advice.",
    price: "$0.06",
    icon: "◎",
    category: "Solana",
    params: [
      { name: "limit", label: "Max pools (1–20)", placeholder: "12", required: false },
      { name: "minLiquidityUsd", label: "Min liquidity USD", placeholder: "0", required: false },
    ],
    handler: solSafeLaunches,
  },
  {
    id: "sol-liquidity",
    name: "Solana Liquidity & Volume",
    tagline: "Pool depth, 24h volume and FDV — room to size in and out?",
    description:
      "Liquidity depth (deep/moderate/thin), 24h volume and FDV for any SPL mint from the deepest DEX pair (DexScreener) — so an agent knows whether it can size in and exit without wrecking the price. No DEX liquidity found → not charged. Not advice.",
    price: "$0.02",
    icon: "◎",
    category: "Solana",
    params: MINT_PARAM,
    handler: solLiquidity,
  },
];
