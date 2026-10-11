/**
 * Credit recovery message definition.
 * Shared between the signing UI (/credits), the API endpoint (/api/credits/recover),
 * and verification tests. Kept separate from server-only code so browser client
 * components can safely import it without bundler conflicts.
 */

/** The exact message the wallet must sign. Readable, because wallets show it. */
export function recoveryMessage(address: string, issuedAt: string): string {
  return [
    "x402 Bazaar — recover credit balance",
    "",
    `Address: ${address.toLowerCase()}`,
    `Issued: ${issuedAt}`,
    "",
    "Signing this re-issues your credit token and moves the remaining balance to it.",
    "Any token issued earlier stops working.",
  ].join("\n");
}
