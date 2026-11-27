/**
 * Robinhood Chain (chain 4663) services — the token-safety angle for tokenized
 * stocks: not "is it a rug" (Robinhood issues them) but "is this the REAL
 * Robinhood AAPL, or a token wearing the ticker?" Authenticity by on-chain
 * bytecode match against the official Stock Token. Isolated; nothing in the other
 * chain paths imports this. Billing: an unreadable chain → UNKNOWN, not charged.
 * Not advice.
 */
import "server-only";
import { getAddress } from "viem";
import { readRhStock } from "./robinhood/stock-reads";

const now = () => new Date().toISOString();

/** rh-stock-verify — authentic Robinhood tokenized stock, or an impersonator? */
export async function rhStockVerify(params: Record<string, string>) {
  const raw = (params.address || params.token || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… Robinhood Chain token address (address=)");
  const address = getAddress(raw);

  const s = await readRhStock(address);
  if (!s) {
    return {
      address,
      chain: "robinhood" as const,
      verdict: "UNKNOWN" as const,
      verified: null,
      headline: "Could not read Robinhood Chain this call — treat as UNVERIFIED. Re-check before trading.",
      detail: {},
      receipt: { refundable: true }, // not charged
      checkedAt: now(),
    };
  }

  const verdict = s.verified ? "AUTHENTIC" : "UNVERIFIED";
  const headline = s.verified
    ? `✅ Authentic Robinhood tokenized stock${s.symbol ? ` (${s.symbol})` : ""} — bytecode matches the official issuance.`
    : s.isContract
      ? "⚠️ NOT an official Robinhood stock token — the bytecode does NOT match Robinhood's issuance. Could be an impersonator wearing the ticker."
      : "⚠️ No contract at this address on Robinhood Chain — not a token.";
  return {
    address,
    chain: "robinhood" as const,
    verdict,
    verified: s.verified,
    headline,
    detail: {
      ticker: s.symbol,
      name: s.name,
      decimals: s.decimals,
      supply: s.supply,
      isContract: s.isContract,
    },
    receipt: { refundable: false },
    checkedAt: now(),
  };
}
