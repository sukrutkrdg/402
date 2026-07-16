/**
 * Rug-probability score — a single deterministic 0-100 risk gate that combines
 * security (token risk), distribution (holder concentration), and market depth
 * (liquidity). tokenRisk alone doesn't weigh liquidity; agents want one number
 * to gate a trade. Higher = riskier.
 */

import "server-only";
import { tokenRisk } from "./onchain";
import { holderDistribution } from "./holders";
import { tokenPrice } from "./onchain-extra";

export async function rugScore(params: Record<string, string>) {
  const address = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Provide a valid 0x… token address");

  const [riskR, holdersR, priceR] = await Promise.allSettled([
    tokenRisk({ address }),
    holderDistribution({ address }),
    tokenPrice({ address }),
  ]);
  if (riskR.status !== "fulfilled" && holdersR.status !== "fulfilled" && priceR.status !== "fulfilled") {
    throw new Error("No on-chain data available for this token");
  }

  const risk = riskR.status === "fulfilled"
    ? (riskR.value as { flags?: string[]; security?: Record<string, unknown> | null; securityChecked?: boolean; sources?: string[] })
    : null;
  // Did the honeypot/tax/holder feed actually run? If not, empty security flags
  // are absence-of-evidence, not evidence-of-safety — we must not score "low".
  const securityChecked = risk
    ? risk.securityChecked ?? (Array.isArray(risk.sources) && risk.sources.includes("goplus"))
    : false;
  const holders = holdersR.status === "fulfilled"
    ? (holdersR.value as { top10Pct?: number; lockedLpPct?: number | null })
    : null;
  const price = priceR.status === "fulfilled"
    ? (priceR.value as { liquidityUsd?: number | null })
    : null;

  const flags = new Set(risk?.flags ?? []);
  const sec = (risk?.security ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : null);

  let score = 0;
  const signals: string[] = [];
  const add = (n: number, why: string) => {
    score += n;
    signals.push(why);
  };

  if (flags.has("honeypot")) add(45, "honeypot");
  if (flags.has("cannot_sell_all")) add(35, "cannot sell all");
  if (flags.has("unverified_source")) add(15, "unverified source");
  if (flags.has("mintable")) add(10, "mintable supply");
  if (flags.has("transfer_pausable")) add(12, "transfers pausable");
  if (flags.has("can_take_back_ownership")) add(15, "ownership reclaimable");
  if (flags.has("hidden_owner")) add(12, "hidden owner");

  const sellTax = num(sec.sellTaxPct);
  if (sellTax !== null && sellTax >= 30) add(25, `sell tax ${sellTax}%`);
  else if (sellTax !== null && sellTax >= 10) add(15, `sell tax ${sellTax}%`);

  const top10 = holders ? num(holders.top10Pct) : null;
  if (top10 !== null && top10 >= 85) add(30, `top-10 hold ${top10}%`);
  else if (top10 !== null && top10 >= 70) add(20, `top-10 hold ${top10}%`);
  else if (top10 !== null && top10 >= 50) add(10, `top-10 hold ${top10}%`);

  const lockedLp = holders ? num(holders.lockedLpPct) : null;
  if (lockedLp !== null && lockedLp < 50) add(18, `LP only ${lockedLp}% locked`);

  const liq = price ? num(price.liquidityUsd) : null;
  if (liq !== null && liq < 1000) add(25, `liquidity $${Math.round(liq)}`);
  else if (liq !== null && liq < 5000) add(15, `low liquidity $${Math.round(liq)}`);
  else if (liq !== null && liq < 20000) add(8, `thin liquidity $${Math.round(liq)}`);

  score = Math.min(score, 100);
  // Without the security feed we can still confirm high/medium from the signals
  // that DID load (holders, liquidity, RPC flags), but we cannot certify "low" —
  // the honeypot/tax checks that most often drive a high score never ran.
  const level = score >= 70 ? "high" : score >= 35 ? "medium" : securityChecked ? "low" : "unknown";
  const degraded = !securityChecked;
  if (degraded) signals.push("security feed unavailable — honeypot/tax not checked");

  return {
    address,
    rugScore: score,
    level, // high | medium | low | unknown (unknown = security feed unavailable)
    degraded,
    signals,
    inputs: {
      top10HolderPct: top10,
      lockedLpPct: lockedLp,
      liquidityUsd: liq,
      sellTaxPct: sellTax,
    },
    note: degraded
      ? "PARTIAL: security provider (honeypot/taxes) was unavailable this call — score reflects holders/liquidity/RPC only and cannot certify low risk. Re-check shortly."
      : "Composite of security flags, holder concentration and liquidity depth. Higher = riskier. Heuristic, not financial advice.",
    // Funnel: the natural next step after a raw rug score.
    upgrade: {
      service: "ai-token-report",
      price: "$0.12",
      why: "AI-written verdict on this token: buy/avoid call, exit plan, signals explained. If you just paid this check, the full report is $0.05 (not $0.12) on this token for the next hour.",
      url: `https://402.com.tr/api/x402/ai-token-report?address=${address}`,
    },
    checkedAt: new Date().toISOString(),
  };
}
