import type { ServiceDef } from "./types";
import { solTokenVerdict } from "../sol-token-verdict";

/**
 * Solana (SPL) services — a parallel, isolated chain arm, settled in USDC on Base
 * over the existing x402 rail (exactly like the NEAR services). No Base/NEAR file
 * imports anything here; the dependency arrow points one way (catalog/index → solana).
 */
export const SOLANA_SERVICES: ServiceDef[] = [
  {
    id: "sol-token-verdict",
    name: "Solana Token Verdict",
    tagline: "One call → SAFE / CAUTION / AVOID for any Solana (SPL) token",
    description:
      "🆕 The token-verdict hero, now for Solana. One call distils SPL safety into a single SAFE / CAUTION / AVOID verdict for any mint: mint & freeze authority (the Solana seize/freeze analog), Token-2022 extensions (permanent-delegate seize, transfer-hook honeypot, non-transferable, frozen-by-default), sellability via Jupiter (buyable-but-not-sellable = honeypot), and LP-lock + holder concentration via RugCheck. Returns the reasons, a confidence and a shareable card — the same shape as the Base token-verdict, so agents branch on it identically. A gating read that can't run is UNKNOWN, not charged. Not financial advice.",
    price: "$0.03",
    icon: "◎",
    category: "Solana",
    params: [{ name: "mint", label: "Solana SPL mint address", placeholder: "e.g. DezXAZ8z…pPB263", required: true }],
    handler: solTokenVerdict,
  },
];
