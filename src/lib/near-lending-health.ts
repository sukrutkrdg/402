/**
 * NEAR lending health — how close is an account's Rhea Lending (formerly
 * Burrow) position to liquidation? The number a lending agent must watch.
 *
 * Health factor, as the Burrow contract computes it:
 *   collateral  = Σ value × volatility_ratio        (each asset discounted)
 *   borrowed    = Σ value ÷ volatility_ratio        (each debt marked up)
 *   health      = collateral ÷ borrowed            (< 100% → liquidatable)
 * Balances are in the token's decimals plus the asset's `extra_decimals`.
 *
 * Positions and asset configs are read from the contract. Prices come from
 * NEAR Intents' token list, not the contract's own oracle, so the figure can
 * differ slightly from the app's; the response says which tokens it priced.
 * LP-collateral positions are listed but not valued.
 */

import "server-only";
import { NEAR_ACCOUNT_RE, viewCall, intentsTokens, findNearToken } from "./near-rpc";

const BURROW = "contract.main.burrow.near";

interface Bal {
  token_id: string;
  balance: string;
  apr?: string;
}
interface AssetDetail {
  token_id: string;
  config: { volatility_ratio: number; extra_decimals: number };
}

type Verdict = "GO" | "HOLD" | "STOP";

export async function nearLendingHealth(params: Record<string, string>) {
  const account = (params.account || params.address || "").trim().toLowerCase();
  if (!NEAR_ACCOUNT_RE.test(account)) throw new Error("Provide a NEAR account, e.g. alice.near or a 64-hex implicit account");
  const checkedAt = new Date().toISOString();

  const [all, assets, tokens] = await Promise.all([
    viewCall<{ supplied?: Bal[]; positions?: Record<string, { collateral?: Bal[]; borrowed?: Bal[] }> } | null>(
      BURROW,
      "get_account_all_positions",
      { account_id: account },
    ),
    viewCall<AssetDetail[]>(BURROW, "get_assets_paged_detailed", { from_index: 0, limit: 200 }),
    intentsTokens(),
  ]);
  if (!Array.isArray(assets)) throw new Error("Rhea Lending asset list unavailable — not charged, retry shortly");
  if (!tokens) throw new Error("NEAR Intents token list unavailable (prices) — not charged, retry shortly");
  if (!all) {
    return { chain: "near" as const, protocol: "Rhea Lending (Burrow)", account, checkedAt, hasPosition: false, verdict: "GO" as Verdict, reasons: ["No Rhea Lending account — nothing borrowed, nothing to liquidate."] };
  }

  const cfg = new Map(assets.map((a) => [a.token_id, a.config]));
  const unpriced = new Set<string>();
  const value = (b: Bal) => {
    const c = cfg.get(b.token_id);
    const t = findNearToken(tokens, b.token_id);
    if (!c || !t || typeof t.price !== "number" || t.price <= 0) {
      unpriced.add(b.token_id);
      return null;
    }
    const amount = Number(b.balance) / 10 ** (t.decimals + c.extra_decimals);
    return { token: b.token_id, symbol: t.symbol, amount: +amount.toPrecision(8), usd: +(amount * t.price).toFixed(2), ratio: c.volatility_ratio / 10000 };
  };

  const positions = all.positions ?? {};
  const regular = positions.REGULAR ?? { collateral: [], borrowed: [] };
  const lpKeys = Object.keys(positions).filter((k) => k !== "REGULAR");
  const collateral = (regular.collateral ?? []).map(value);
  const borrowed = (regular.borrowed ?? []).map(value);
  const supplied = (all.supplied ?? []).map(value).filter(Boolean);

  const adjColl = collateral.reduce((s, v) => s + (v ? v.usd * v.ratio : 0), 0);
  const adjDebt = borrowed.reduce((s, v) => s + (v ? v.usd / v.ratio : 0), 0);
  const debtUsd = borrowed.reduce((s, v) => s + (v?.usd ?? 0), 0);
  const collUsd = collateral.reduce((s, v) => s + (v?.usd ?? 0), 0);
  const debtUnpriced = (regular.borrowed ?? []).some((b) => unpriced.has(b.token_id));

  const reasons: string[] = [];
  let verdict: Verdict = "GO";
  let healthPct: number | null = null;
  let dropToLiquidationPct: number | null = null;
  if (!(regular.borrowed ?? []).length) {
    reasons.push("Nothing borrowed in the regular position — it cannot be liquidated.");
  } else if (debtUnpriced) {
    verdict = "HOLD";
    reasons.push(`Could not price borrowed ${[...unpriced].join(", ")}, so health is not measured.`);
  } else {
    healthPct = adjDebt > 0 ? +((adjColl / adjDebt) * 100).toFixed(2) : null;
    if (healthPct !== null) {
      dropToLiquidationPct = healthPct > 100 ? +((1 - 100 / healthPct) * 100).toFixed(2) : 0;
      if (healthPct < 100) {
        verdict = "STOP";
        reasons.push(`Health ${healthPct}% — below 100%: the position can be liquidated now.`);
      } else if (healthPct < 110) {
        verdict = "STOP";
        reasons.push(`Health ${healthPct}% — a ${dropToLiquidationPct}% fall in collateral value liquidates it. Repay or add collateral now.`);
      } else if (healthPct < 150) {
        verdict = "HOLD";
        reasons.push(`Health ${healthPct}% — liquidated after a ${dropToLiquidationPct}% fall in collateral value. Watch it; do not borrow more.`);
      } else {
        reasons.push(`Health ${healthPct}% — collateral value would have to fall ${dropToLiquidationPct}% before liquidation.`);
      }
    }
  }
  if (unpriced.size && !debtUnpriced) reasons.push(`Collateral not priced (counted as zero, so health is understated): ${[...unpriced].join(", ")}.`);
  if (lpKeys.length) reasons.push(`${lpKeys.length} LP-collateral position(s) not valued here: ${lpKeys.join(", ")}.`);

  return {
    chain: "near" as const,
    protocol: "Rhea Lending (Burrow)",
    contract: BURROW,
    account,
    checkedAt,
    hasPosition: true,
    verdict,
    healthPct,
    dropToLiquidationPct,
    reasons,
    collateralUsd: +collUsd.toFixed(2),
    borrowedUsd: +debtUsd.toFixed(2),
    collateral: collateral.filter(Boolean),
    borrowed: borrowed.filter(Boolean),
    supplied,
    lpPositions: lpKeys,
    method:
      "health = Σ(collateral USD × volatility_ratio) ÷ Σ(debt USD ÷ volatility_ratio), as the contract defines it; volatility ratios from the contract, prices from NEAR Intents (may differ slightly from the contract's oracle). dropToLiquidation assumes all collateral falls together.",
  };
}
