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
import { realStockPrice } from "./stock-quote";

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
    headline: `$${m.priceUsd} on-chain — ${depth} liquidity ($${Math.round(m.liquidityUsd ?? 0).toLocaleString()}), $${Math.round(m.volume24hUsd ?? 0).toLocaleString()} 24h volume.`,
    note: "On-chain DEX price of the tokenized stock — compare to the real equity to spot a de-peg. Not advice.",
    receipt: { refundable: false },
    checkedAt: now(),
  };
}

/** rh-stock-peg — does the tokenized stock still track the real equity, or has it de-pegged? */
export async function rhStockPeg(params: Record<string, string>) {
  const address = addrOf(params);
  const [s, m] = await Promise.all([readRhStock(address), rhMarket(address)]);
  const ticker = s?.symbol ?? null;
  if (!s || !ticker) {
    return { address, chain: "robinhood" as const, verdict: "UNKNOWN", pegPct: null, note: "Could not read the stock ticker on-chain — not charged.", receipt: { refundable: true }, checkedAt: now() };
  }
  const real = await realStockPrice(ticker);
  if (!m || m.priceUsd === null || real === null) {
    return { address, chain: "robinhood" as const, ticker, verdict: "UNKNOWN", pegPct: null, note: "On-chain or real price unavailable this call — not charged.", receipt: { refundable: true }, checkedAt: now() };
  }
  const pegPct = ((m.priceUsd - real) / real) * 100;
  const abs = Math.abs(pegPct);
  const verdict = abs < 2 ? "IN_PEG" : pegPct > 0 ? "PREMIUM" : "DISCOUNT";
  return {
    address,
    chain: "robinhood" as const,
    ticker,
    verdict,
    verified: s.verified,
    onchainPriceUsd: m.priceUsd,
    realPriceUsd: real,
    pegPct: +pegPct.toFixed(2),
    headline:
      verdict === "IN_PEG"
        ? `${ticker} tracking its real price — on-chain $${m.priceUsd} vs real $${real} (${pegPct >= 0 ? "+" : ""}${pegPct.toFixed(2)}%).`
        : `${ticker} trading at a ${abs.toFixed(2)}% ${verdict === "PREMIUM" ? "PREMIUM over" : "DISCOUNT to"} its real price — on-chain $${m.priceUsd} vs real $${real}.`,
    note: "On-chain DEX price vs the real equity's last market price (Yahoo). A wide gap = premium/discount (thin pools, after-hours, or stale). Not advice.",
    receipt: { refundable: false },
    checkedAt: now(),
  };
}

/** rh-stock-bundle — the whole Robinhood-stock read in one call: authenticity + price + peg + liquidity. */
export async function rhStockBundle(params: Record<string, string>) {
  const address = addrOf(params);
  const [s, m] = await Promise.all([readRhStock(address), rhMarket(address)]);
  if (!s) {
    return { address, chain: "robinhood" as const, verdict: "UNKNOWN", note: "Could not read Robinhood Chain this call — not charged.", receipt: { refundable: true }, checkedAt: now() };
  }
  const ticker = s.symbol ?? null;
  const real = ticker ? await realStockPrice(ticker) : null;
  const pegPct = m?.priceUsd != null && real != null ? ((m.priceUsd - real) / real) * 100 : null;
  const pegVerdict = pegPct == null ? "UNKNOWN" : Math.abs(pegPct) < 2 ? "IN_PEG" : pegPct > 0 ? "PREMIUM" : "DISCOUNT";
  return {
    address,
    chain: "robinhood" as const,
    ticker,
    name: s.name,
    authentic: s.verified,
    onchainPriceUsd: m?.priceUsd ?? null,
    realPriceUsd: real,
    pegPct: pegPct != null ? +pegPct.toFixed(2) : null,
    pegVerdict,
    liquidityUsd: m?.liquidityUsd ?? null,
    volume24hUsd: m?.volume24hUsd ?? null,
    supply: s.supply,
    headline: `${ticker ?? "?"}: ${s.verified ? "AUTHENTIC" : "UNVERIFIED"}${pegPct != null ? ` · ${pegVerdict} (${pegPct >= 0 ? "+" : ""}${pegPct.toFixed(2)}%)` : ""}${m?.priceUsd != null ? ` · $${m.priceUsd} on-chain` : ""}.`,
    note: "Authenticity (official issuance?), on-chain vs real price (peg), and liquidity — in one call. Not advice.",
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
