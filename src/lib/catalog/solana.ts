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
      "🆕 token-verdict for Solana — one call → SAFE / CAUTION / AVOID for any SPL mint: mint & freeze authority (the Solana seize/freeze analog), Token-2022 extensions (permanent-delegate seize, transfer-hook honeypot, non-transferable, frozen-by-default), Jupiter sellability (buy-but-not-sell = honeypot) and RugCheck LP-lock + concentration. Same output shape as the Base hero. An unrunnable gating read is UNKNOWN, not charged. Not advice.",
    price: "$0.03",
    icon: "◎",
    category: "Solana",
    params: [{ name: "mint", label: "Solana SPL mint address", placeholder: "e.g. DezXAZ8z…pPB263", required: true }],
    handler: solTokenVerdict,
  },
];
