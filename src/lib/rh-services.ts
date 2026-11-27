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
import { readRhStock, rhMarket } from "./robinhood/stock-reads";

const now = () => new Date().toISOString();

function addrOf(params: Record<string, string>): string {
  const raw = (params.address || params.token || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… Robinhood Chain token address (address=)");
  return getAddress(raw);
}

/** rh-stock-price — the on-chain tradeable price, liquidity and 24h volume for a Robinhood stock token. */
export async function rhStockPrice(params: Record<string, string>) {
  const address = addrOf(params);
  const m = await rhMarket(address);
  if (!m || m.priceUsd === null) {
    return { address, chain: "robinhood" as const, priceUsd: null, note: "No DEX price on Robinhood Chain this call — not charged.", receipt: { refundable: true }, checkedAt: now() };
  }
  const depth = (m.liquidityUsd ?? 0) >= 100000 ? "deep" : (m.liquidityUsd ?? 0) >= 10000 ? "moderate" : "thin";
  return {
    address,
    chain: "robinhood" as const,
    priceUsd: m.priceUsd,
    liquidityUsd: m.liquidityUsd,
    volume24hUsd: m.volume24hUsd,
    depth,
    pool: m.pool,
    headline: `$${m.priceUsd} on-chain${m.pool ? ` (${m.pool})` : ""} — ${depth} liquidity, $${Math.round(m.volume24hUsd ?? 0).toLocaleString()} 24h volume.`,
    note: "On-chain DEX price of the tokenized stock — compare to the real equity to spot a de-peg. Not advice.",
    receipt: { refundable: false },
    checkedAt: now(),
  };
}

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
