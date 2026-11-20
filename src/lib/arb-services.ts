/**
 * Arbitrum (chain 42161) token-safety services — the Base hero stack, for the
 * biggest EVM L2. Same token-verdict shape agents already branch on, built on one
 * GoPlus token_security call. Billing parity: when the security read can't run the
 * answer is UNKNOWN with `receipt.refundable = true` — never charged, never a
 * false SAFE. Isolated: nothing in Base/NEAR/Solana imports this. Not advice.
 */
import "server-only";
import { getAddress } from "viem";
import { getSiteUrl } from "./config";
import { arbTokenSecurity, type ArbSecurity } from "./arbitrum/token-security";

type Verdict = "SAFE" | "CAUTION" | "AVOID" | "UNKNOWN";

const HEADLINE: Record<Verdict, string> = {
  SAFE: "Looks clean — not a honeypot, sellable, taxes sane, no critical owner power.",
  CAUTION: "Tradeable, but with real risks — size down and stay exit-ready.",
  AVOID: "Do not trade — a terminal flag is set (honeypot, can't-sell, or self-destruct).",
  UNKNOWN: "Not verified — the security read could not run. Re-check before trading.",
};

function addressOf(params: Record<string, string>): string {
  const raw = (params.address || params.token || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… Arbitrum token address (address=)");
  return getAddress(raw);
}

const now = () => new Date().toISOString();
const unverified = (address: string, extra: Record<string, unknown>) =>
  ({ address, chain: "arbitrum" as const, ...extra, receipt: { refundable: true }, checkedAt: now() });

/** Build the AVOID / CAUTION / positives lists from a GoPlus Arbitrum security read. */
function assess(s: ArbSecurity) {
  const avoid: string[] = [];
  const caution: string[] = [];
  const positives: string[] = [];

  if (s.isHoneypot) avoid.push("GoPlus flags this as a HONEYPOT — you would not be able to sell");
  if (s.cannotSellAll) avoid.push("Cannot sell all — the contract blocks selling your full balance");
  if (s.selfdestruct) avoid.push("Contract can self-destruct — the token can be wiped");
  if ((s.sellTaxPct ?? 0) >= 50) avoid.push(`Sell tax is ${s.sellTaxPct!.toFixed(0)}% — an effective honeypot`);

  if (!s.isHoneypot && s.cannotSellAll === false) positives.push("Sellable — GoPlus found no honeypot or sell block");
  if ((s.sellTaxPct ?? 0) > 0 && (s.sellTaxPct ?? 0) < 50) caution.push(`Sell tax is ${s.sellTaxPct!.toFixed(1)}% — confirm before trading`);
  if ((s.buyTaxPct ?? 0) >= 10) caution.push(`Buy tax is ${s.buyTaxPct!.toFixed(1)}%`);
  if (s.isMintable) caution.push("Supply is mintable — it can be inflated (dilution)"); else if (s.isMintable === false) positives.push("Not mintable — supply is fixed");
  if (!s.ownerRenounced && (s.canTakeBackOwnership || s.hiddenOwner)) caution.push("Owner can reclaim/hide control — a rug lever");
  else if (s.ownerRenounced) positives.push("Ownership renounced");
  if (s.transferPausable) caution.push("Transfers are pausable — the issuer can freeze trading");
  if (s.isBlacklisted) caution.push("Holders can be blacklisted — your address could be blocked from selling");
  if (s.isProxy) caution.push("Upgradeable proxy — the logic can change after you buy");
  if (s.isOpenSource === false) caution.push("Contract is NOT verified/open-source");
  if (typeof s.lpLockedPct === "number" && s.lpLockedPct < 50) caution.push(`Only ${s.lpLockedPct.toFixed(0)}% of LP is locked — rug setup`);
  if (typeof s.top10Pct === "number" && s.top10Pct >= 50) caution.push(`Top-10 holders own ${s.top10Pct.toFixed(0)}% — concentrated`);

  return { avoid, caution, positives };
}

/** arb-token-verdict — SAFE / CAUTION / AVOID for any Arbitrum token. */
export async function arbTokenVerdict(params: Record<string, string>) {
  const address = addressOf(params);
  const s = await arbTokenSecurity(address);
  if (!s) return { ...unverified(address, { verdict: "UNKNOWN", confidence: "low", headline: HEADLINE.UNKNOWN, reasons: ["GoPlus could not be read this call — treat as UNVERIFIED, not safe."], recommendedMaxSizeUsd: null, detail: {} }), card: `${address.slice(0, 6)}…${address.slice(-4)} → UNKNOWN`, cardUrl: `${getSiteUrl()}/brand/verdict?v=UNKNOWN&addr=${address}` };

  const { avoid, caution, positives } = assess(s);
  const verdict: Verdict = avoid.length ? "AVOID" : caution.length ? "CAUTION" : "SAFE";
  const reasons = (avoid.length ? avoid : caution.length ? caution : positives).slice(0, 4);
  const confidence: "high" | "medium" = "high";
  const recommendedMaxSizeUsd = verdict === "AVOID" ? 0 : null;
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const card = `${short} → ${verdict} (${confidence} confidence). ${reasons[0] ?? ""}`;
  const cardUrl = `${getSiteUrl()}/brand/verdict?v=${verdict}&addr=${address}&conf=${confidence}&reason=${encodeURIComponent(reasons[0] ?? "")}`;

  return {
    address,
    chain: "arbitrum" as const,
    verdict,
    confidence,
    headline: HEADLINE[verdict],
    reasons,
    recommendedMaxSizeUsd,
    detail: {
      tokenSymbol: s.tokenSymbol,
      isHoneypot: s.isHoneypot,
      buyTaxPct: s.buyTaxPct,
      sellTaxPct: s.sellTaxPct,
      isMintable: s.isMintable,
      ownerRenounced: s.ownerRenounced,
      transferPausable: s.transferPausable,
      isProxy: s.isProxy,
      isOpenSource: s.isOpenSource,
      lpLockedPct: s.lpLockedPct,
      top10Pct: s.top10Pct,
      holderCount: s.holderCount,
      positives,
    },
    card,
    cardUrl,
    receipt: { confidence: { band: confidence }, refundable: false },
    checkedAt: now(),
  };
}

/** arb-sellability — honeypot / can-you-sell for an Arbitrum token. */
export async function arbSellability(params: Record<string, string>) {
  const address = addressOf(params);
  const s = await arbTokenSecurity(address);
  if (!s) return unverified(address, { sellable: null, note: "GoPlus did not answer — not charged; retry shortly." });
  const honeypot = s.isHoneypot === true || s.cannotSellAll === true;
  const sellable = honeypot ? false : s.isHoneypot === false ? true : null;
  return {
    address,
    chain: "arbitrum" as const,
    sellable,
    honeypot,
    sellTaxPct: s.sellTaxPct,
    headline: honeypot
      ? "HONEYPOT — GoPlus says you cannot sell (honeypot or sell-all block)."
      : sellable
        ? `Sellable — no honeypot; sell tax ${(s.sellTaxPct ?? 0).toFixed(1)}%.`
        : "Sellability unknown from GoPlus this call.",
    detail: { transferPausable: s.transferPausable, isBlacklisted: s.isBlacklisted },
    receipt: { refundable: false },
    checkedAt: now(),
  };
}

/** arb-token-risk — the GoPlus risk flags for an Arbitrum token, as a list. */
export async function arbTokenRisk(params: Record<string, string>) {
  const address = addressOf(params);
  const s = await arbTokenSecurity(address);
  if (!s) return unverified(address, { flags: null, note: "GoPlus did not answer — not charged; retry shortly." });
  const { avoid, caution, positives } = assess(s);
  const level = avoid.length ? "high" : caution.length >= 3 ? "high" : caution.length ? "medium" : "low";
  return {
    address,
    chain: "arbitrum" as const,
    level,
    headline: `Risk ${level} — ${avoid.length} terminal, ${caution.length} caution flag(s).`,
    terminal: avoid,
    warnings: caution,
    positives,
    detail: { tokenSymbol: s.tokenSymbol, holderCount: s.holderCount, isOpenSource: s.isOpenSource },
    receipt: { refundable: false },
    checkedAt: now(),
  };
}
