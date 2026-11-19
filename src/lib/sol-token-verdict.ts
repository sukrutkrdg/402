/**
 * sol-token-verdict — the token-verdict hero, for Solana (SPL).
 *
 * One call distils SPL safety into SAFE / CAUTION / AVOID for any mint, using the
 * mint account as ground truth (mint/freeze authority, Token-2022 extensions),
 * Jupiter for sellability (buyable-but-not-sellable = honeypot), and RugCheck for
 * LP-lock + concentration. Returns the SAME shape as the Base token-verdict so
 * agents branch on it identically.
 *
 * Billing parity with token-verdict.ts: a gating read (the mint) that could not
 * run is UNKNOWN with `receipt.refundable = true` — never charged, never a false
 * SAFE. Fully isolated: nothing in the Base/NEAR paths imports this. Not advice.
 */
import "server-only";
import { getSiteUrl } from "./config";
import { readSplMint, rugcheckSummary, jupiterSell, jupiterShield, type SplMint } from "./solana/token-reads";

type Verdict = "SAFE" | "CAUTION" | "AVOID" | "UNKNOWN";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const HEADLINE: Record<Verdict, string> = {
  SAFE: "Looks clean — mint & freeze authority renounced, a sell routes, no seize extensions.",
  CAUTION: "Tradeable, but with real risks — size down and stay exit-ready.",
  AVOID: "Do not trade — a terminal flag is set (seize, honeypot, or freeze-trap).",
  UNKNOWN: "Not verified — the mint could not be read. Re-check before trading.",
};

/** Token-2022 extensions that are terminal (seize / honeypot vectors). */
const TERMINAL_EXT: Record<string, string> = {
  permanentDelegate: "Token-2022 permanent delegate can seize any holder's balance",
  transferHook: "Token-2022 transfer hook can block your sell (programmable honeypot)",
  nonTransferable: "Token is non-transferable — you cannot sell it",
};

export async function solTokenVerdict(params: Record<string, string>) {
  const mint = (params.mint || params.address || params.token || "").trim();
  if (!BASE58.test(mint)) throw new Error("Provide a valid Solana SPL mint address (mint=)");

  let m: SplMint;
  try {
    m = await readSplMint(mint);
  } catch {
    return degraded(mint);
  }

  const [rug, sell, shield] = await Promise.all([
    rugcheckSummary(mint),
    jupiterSell(mint, m.decimals),
    jupiterShield(mint),
  ]);

  const avoid: string[] = [];
  const caution: string[] = [];
  const positives: string[] = [];

  // Token-2022 terminal extensions.
  const extTypes = new Set(m.extensions.map(e => e.type));
  for (const [k, msg] of Object.entries(TERMINAL_EXT)) if (extTypes.has(k)) avoid.push(msg);
  const das = m.extensions.find(e => e.type === "defaultAccountState");
  if (das && typeof das.state === "string" && das.state.toLowerCase() === "frozen")
    avoid.push("Token-2022 default account state is FROZEN — new holders are frozen until the issuer thaws them (honeypot)");
  if (extTypes.has("transferFeeConfig")) caution.push("Token-2022 transfer fee (a sell tax) is set — confirm the rate before trading");

  // Sellability (Jupiter).
  if (sell && sell.sellable === false) {
    if (m.freezeAuthority) avoid.push("Buyable but no sell route found, and a freeze authority is active — honeypot pattern");
    else caution.push("No sell route found right now — illiquid or not yet tradeable; confirm you can exit");
  } else if (sell?.sellable) {
    positives.push("A sell route to USDC exists (you can exit)");
  }

  // Authorities.
  if (m.freezeAuthority) caution.push("Freeze authority is active — the issuer can freeze your account and block sells");
  else positives.push("Freeze authority renounced");
  if (m.mintAuthority) caution.push("Mint authority is active — supply can be inflated (dilution)");
  else positives.push("Mint authority renounced");

  // RugCheck aggregate.
  if (rug) {
    if (typeof rug.lpLockedPct === "number" && rug.lpLockedPct < 50)
      caution.push(`Only ${rug.lpLockedPct.toFixed(0)}% of LP is locked/burned — rug setup`);
    for (const r of rug.risks) {
      if (r.level === "danger") avoid.push(`[rugcheck] ${r.name}`);
      else if (r.name && !/mutable metadata/i.test(r.name)) caution.push(`[rugcheck] ${r.name}`);
    }
  }
  // Jupiter Shield warnings.
  for (const w of shield ?? []) if (w && !caution.some(c => c.includes(w))) caution.push(`[shield] ${w}`);

  const verdict: Verdict = avoid.length ? "AVOID" : caution.length ? "CAUTION" : "SAFE";
  const reasons = (avoid.length ? avoid : caution.length ? caution : positives).slice(0, 4);
  const secondaryMissing = !rug || !sell;
  const confidence: "high" | "medium" | "low" = secondaryMissing ? "medium" : "high";
  const recommendedMaxSizeUsd = verdict === "AVOID" ? 0 : null;

  const short = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  const card = `${short} → ${verdict} (${confidence} confidence). ${reasons[0] ?? ""}`;
  const cardUrl =
    `${getSiteUrl()}/brand/verdict?v=${verdict}&conf=${confidence}&reason=${encodeURIComponent(reasons[0] ?? "")}`;

  return {
    mint,
    chain: "solana",
    verdict,
    confidence,
    headline: HEADLINE[verdict],
    reasons,
    recommendedMaxSizeUsd,
    detail: {
      program: m.program,
      mintAuthority: m.mintAuthority,
      freezeAuthority: m.freezeAuthority,
      decimals: m.decimals,
      token2022Extensions: m.extensions.map(e => e.type),
      sellable: sell?.sellable ?? null,
      priceImpactPct: sell?.priceImpactPct ?? null,
      lpLockedPct: rug?.lpLockedPct ?? null,
      rugcheckScore: rug?.scoreNormalised ?? null,
      shieldWarnings: shield ?? null,
      positives,
    },
    card,
    cardUrl,
    receipt: { confidence: { band: confidence }, refundable: false },
    checkedAt: new Date().toISOString(),
  };
}

function degraded(mint: string) {
  return {
    mint,
    chain: "solana",
    verdict: "UNKNOWN" as const,
    confidence: "low" as const,
    headline: HEADLINE.UNKNOWN,
    reasons: ["The mint account could not be read this call — treat as UNVERIFIED, not safe."],
    recommendedMaxSizeUsd: null,
    detail: {},
    card: `${mint.slice(0, 4)}…${mint.slice(-4)} → UNKNOWN (not verified)`,
    cardUrl: `${getSiteUrl()}/brand/verdict?v=UNKNOWN`,
    receipt: { confidence: { band: "low" }, refundable: true }, // not charged
    checkedAt: new Date().toISOString(),
  };
}
