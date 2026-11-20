/**
 * Solana (SPL) agent services — the token-safety suite Solana trading agents call
 * every trade, built on the same keyless read layer as sol-token-verdict and the
 * same billing rule: when the PRIMARY source for a service can't be read, the
 * answer is UNVERIFIED with `receipt.refundable = true` — never charged, never a
 * false positive. Fully isolated: nothing in the Base/NEAR paths imports this.
 * Not advice.
 */
import "server-only";
import {
  readSplMint,
  rugcheckSummary,
  jupiterSell,
  splTopHolders,
  dexscreenerMarket,
  type SplMint,
} from "./solana/token-reads";
import { solTokenVerdict } from "./sol-token-verdict";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function mintOf(params: Record<string, string>): string {
  const m = (params.mint || params.address || params.token || "").trim();
  if (!BASE58.test(m)) throw new Error("Provide a valid Solana SPL mint address (mint=)");
  return m;
}

const now = () => new Date().toISOString();
/** Primary source unreadable → UNVERIFIED, not charged. */
function unverified(mint: string, extra: Record<string, unknown>) {
  return { mint, chain: "solana" as const, ...extra, receipt: { refundable: true }, checkedAt: now() };
}
function answered(mint: string, extra: Record<string, unknown>) {
  return { mint, chain: "solana" as const, ...extra, receipt: { refundable: false }, checkedAt: now() };
}

/** sol-pre-trade-gate — GO / HOLD / STOP. Reuses the verdict so the logic never forks. */
export async function solPreTradeGate(params: Record<string, string>) {
  const v = await solTokenVerdict(params);
  const gate =
    v.verdict === "SAFE" ? "GO" : v.verdict === "CAUTION" ? "HOLD" : v.verdict === "AVOID" ? "STOP" : "UNKNOWN";
  const headline =
    gate === "GO" ? "GO — no terminal flags; size to your normal risk."
    : gate === "HOLD" ? "HOLD — real risks; size down and keep an exit ready."
    : gate === "STOP" ? "STOP — a terminal flag is set (seize, honeypot, or freeze-trap)."
    : "UNKNOWN — the mint could not be read; re-check before trading.";
  return {
    mint: v.mint,
    chain: "solana" as const,
    gate,
    verdict: v.verdict,
    confidence: v.confidence,
    headline,
    reasons: v.reasons,
    recommendedMaxSizeUsd: v.recommendedMaxSizeUsd,
    detail: v.detail,
    receipt: v.receipt,
    checkedAt: v.checkedAt,
  };
}

/** sol-token-risk — RugCheck risk score (0 = clean … 100 = max risk) + the flags behind it. */
export async function solTokenRisk(params: Record<string, string>) {
  const mint = mintOf(params);
  const rug = await rugcheckSummary(mint);
  if (!rug || rug.scoreNormalised === null)
    return unverified(mint, { score: null, level: "unknown", risks: [], note: "RugCheck did not answer — not charged; retry shortly." });
  const score = rug.scoreNormalised;
  const level = score < 20 ? "low" : score < 50 ? "medium" : "high";
  const dangers = rug.risks.filter(r => r.level === "danger").map(r => r.name);
  const warnings = rug.risks.filter(r => r.level !== "danger").map(r => r.name).slice(0, 6);
  return answered(mint, {
    score,
    level,
    headline: `Risk ${score}/100 (${level}).` + (dangers[0] ? ` Danger: ${dangers[0]}.` : ""),
    dangers,
    warnings,
    detail: { lpLockedPct: rug.lpLockedPct },
  });
}

/** sol-sellability — can you SELL back to USDC, or is it a honeypot? */
export async function solSellability(params: Record<string, string>) {
  const mint = mintOf(params);
  let m: SplMint;
  try {
    m = await readSplMint(mint);
  } catch {
    return unverified(mint, { sellable: null, note: "The mint could not be read — not charged." });
  }
  const sell = await jupiterSell(mint, m.decimals);
  if (!sell) return unverified(mint, { sellable: null, note: "Jupiter did not answer — not charged; retry shortly." });
  const honeypot = sell.sellable === false && !!m.freezeAuthority;
  const headline = honeypot
    ? "HONEYPOT pattern — buyable but no sell route AND a freeze authority is active."
    : sell.sellable
      ? "Sellable — a route back to USDC exists."
      : "No sell route right now — illiquid or not yet tradeable; confirm you can exit.";
  return answered(mint, {
    sellable: sell.sellable,
    honeypot,
    priceImpactPct: sell.priceImpactPct,
    headline,
    detail: { freezeAuthority: m.freezeAuthority },
  });
}

/** sol-lp-check — how much of the LP is locked or burned (rug-pull setup detector). */
export async function solLpCheck(params: Record<string, string>) {
  const mint = mintOf(params);
  const rug = await rugcheckSummary(mint);
  if (!rug || rug.lpLockedPct === null)
    return unverified(mint, { lpLockedPct: null, locked: null, note: "RugCheck did not report LP — not charged." });
  const pct = rug.lpLockedPct;
  const locked = pct >= 50;
  return answered(mint, {
    lpLockedPct: pct,
    locked,
    level: pct >= 90 ? "strong" : pct >= 50 ? "partial" : "weak",
    headline: `${pct.toFixed(0)}% of LP locked/burned — ${locked ? "liquidity can't be pulled freely" : "rug-pull setup (LP can be pulled)"}.`,
  });
}

/** sol-holder-concentration — top-10 holder % (incl. pools), an insider/bundle signal. */
export async function solHolderConcentration(params: Record<string, string>) {
  const mint = mintOf(params);
  let m: SplMint;
  try {
    m = await readSplMint(mint);
  } catch {
    return unverified(mint, { top10Pct: null, note: "The mint could not be read — not charged." });
  }
  const h = await splTopHolders(mint, m.supply);
  if (!h || h.top10Pct === null)
    return unverified(mint, { top10Pct: null, note: "Holder data unavailable — not charged; retry shortly." });
  const pct = h.top10Pct;
  const level = pct >= 70 ? "high" : pct >= 40 ? "medium" : "low";
  return answered(mint, {
    top10Pct: pct,
    topHolderPct: h.topPct,
    concentration: level,
    headline: `Top 10 accounts hold ${pct.toFixed(0)}% of supply (${level} concentration).`,
    note: "Raw concentration — the largest accounts can include the LP pool, CEX or a burn address.",
    detail: { topHolders: h.accounts.map(a => ({ address: a.address, pct: +a.pct.toFixed(2) })) },
  });
}

/** sol-price — spot USD price from the deepest DEX pair. */
export async function solPrice(params: Record<string, string>) {
  const mint = mintOf(params);
  const d = await dexscreenerMarket(mint);
  if (!d || d.priceUsd === null)
    return unverified(mint, { priceUsd: null, note: "No DEX price found — not charged." });
  return answered(mint, {
    priceUsd: d.priceUsd,
    fdvUsd: d.fdvUsd,
    pairs: d.pairs,
    headline: `$${d.priceUsd} per token (deepest of ${d.pairs} pair${d.pairs === 1 ? "" : "s"}).`,
    detail: { topPairUrl: d.topPairUrl },
  });
}

/** sol-liquidity — pool depth, 24h volume and FDV (is there room to size in and out?). */
export async function solLiquidity(params: Record<string, string>) {
  const mint = mintOf(params);
  const d = await dexscreenerMarket(mint);
  if (!d || d.liquidityUsd === null)
    return unverified(mint, { liquidityUsd: null, note: "No DEX liquidity found — not charged." });
  const liq = d.liquidityUsd;
  const depth = liq >= 250000 ? "deep" : liq >= 25000 ? "moderate" : "thin";
  return answered(mint, {
    liquidityUsd: liq,
    volume24hUsd: d.volume24hUsd,
    fdvUsd: d.fdvUsd,
    pairs: d.pairs,
    depth,
    headline: `$${Math.round(liq).toLocaleString()} liquidity (${depth}), $${Math.round(d.volume24hUsd ?? 0).toLocaleString()} 24h volume.`,
    detail: { topPairUrl: d.topPairUrl },
  });
}
