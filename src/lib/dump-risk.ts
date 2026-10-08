/**
 * dump-risk — the exit-liquidity question every token-risk tool gestures at but
 * none quantifies: if the biggest holders sell, can the liquidity absorb it?
 *
 * "Top holder owns 18%" is meaningless without the other half: 18% of WHAT,
 * against how deep a pool. A 18% bag worth $40k over a $2M pool is nothing; the
 * same 18% worth $2M over a $300k pool is a trap where the holder's exit is YOUR
 * entry at a crater. This puts the two numbers together.
 *
 *   holders (GoPlus) → top holders, their % of supply, and whether each is a pool,
 *     a locked/burn address or a live wallet (only live wallets can actually dump).
 *   pools (DexScreener) → aggregate Base liquidity + market cap to value the bag.
 *   impact → the same conservative constant-product math price-impact uses, applied
 *     to the largest DUMPABLE holder and to the top three combined.
 *
 * Heuristic and conservative; GoPlus %s and DexScreener snapshots. Not a price
 * feed, not financial advice.
 */

import "server-only";
import { getAddress } from "viem";
import { goPlusSecurity, dexTokenPairs } from "./upstream-cache";

interface GpHolder { address?: string; tag?: string; is_contract?: number | string; is_locked?: number | string; percent?: string }
type Gp = Record<string, unknown> & { holders?: GpHolder[] };
interface Pair {
  baseToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
}

const validAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test((a ?? "").trim());
const isTrue = (v: unknown) => v === "1" || v === 1 || v === true;
const num = (v: unknown) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : 0; };
const BURN = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);
// Tags GoPlus puts on holders that cannot market-sell into the pool.
const NON_DUMPABLE_TAG = /lock|burn|null|pair|pool|uniswap|aerodrome|sushi|pancake|dead/i;

/** Conservative constant-product executed-vs-spot loss for a `size` USD trade against a `reserve` USD side. */
const cpImpact = (size: number, reserve: number) => (reserve <= 0 ? 1 : size / (reserve + size));

export async function dumpRisk(params: Record<string, string>) {
  const raw = (params.address || params.token || "").trim();
  if (!validAddr(raw)) throw new Error("Provide a valid 0x… token address");
  const address = getAddress(raw);

  const [gp, pairs] = await Promise.all([
    goPlusSecurity<Gp>(address),
    dexTokenPairs<Pair>(address),
  ]);
  if (gp === null && pairs === null) throw new Error("Holder and pool data both unavailable — not charged, retry shortly");
  if (!gp || !Array.isArray(gp.holders) || gp.holders.length === 0) {
    throw new Error("No holder data for this token (GoPlus) — not charged, retry shortly");
  }

  const addrLc = address.toLowerCase();
  const base = (pairs || []).filter((p) => p?.baseToken?.address?.toLowerCase() === addrLc);
  const aggLiquidityUsd = base.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  const priceUsd = base.map((p) => Number(p.priceUsd)).find((n) => Number.isFinite(n) && n > 0) ?? null;
  // Prefer circulating market cap; fall back to FDV. Needed to value a % bag in USD.
  const marketCap = base.map((p) => p.marketCap).find((n) => n && n > 0)
    ?? base.map((p) => p.fdv).find((n) => n && n > 0)
    ?? null;

  const holders = gp.holders.map((h) => {
    const addr = String(h.address ?? "").toLowerCase();
    const locked = isTrue(h.is_locked) || BURN.has(addr) || NON_DUMPABLE_TAG.test(h.tag ?? "");
    return { address: h.address ?? null, percent: +(num(h.percent) * 100).toFixed(2), tag: h.tag || null, isContract: isTrue(h.is_contract), dumpable: !locked };
  });

  const dumpable = holders.filter((h) => h.dumpable).sort((a, b) => b.percent - a.percent);
  const topHolder = dumpable[0] ?? null;
  const top3Pct = +dumpable.slice(0, 3).reduce((s, h) => s + h.percent, 0).toFixed(2);

  // Value the bags. Without a market cap we can't turn a % into USD; say so rather than guess.
  const bagUsd = (pct: number) => (marketCap ? (pct / 100) * marketCap : null);
  const reserve = aggLiquidityUsd / 2; // 50/50 constant-product assumption, aggregated across pools

  const topBagUsd = topHolder ? bagUsd(topHolder.percent) : null;
  const top3BagUsd = bagUsd(top3Pct);
  const topImpactPct = topBagUsd != null ? +(cpImpact(topBagUsd, reserve) * 100).toFixed(1) : null;
  const top3ImpactPct = top3BagUsd != null ? +(cpImpact(top3BagUsd, reserve) * 100).toFixed(1) : null;

  let verdict: "resilient" | "absorbable" | "fragile" | "exit_trap" | "no_liquidity" | "unknown";
  if (aggLiquidityUsd <= 0) verdict = "no_liquidity";
  else if (topImpactPct == null) verdict = "unknown";
  else if (topImpactPct < 5) verdict = "resilient";
  else if (topImpactPct < 20) verdict = "absorbable";
  else if (topImpactPct < 50) verdict = "fragile";
  else verdict = "exit_trap";

  const usd = (n: number | null) => (n == null ? "?" : `$${Math.round(n).toLocaleString("en-US")}`);
  return {
    address,
    holderCount: gp.holder_count !== undefined ? Number(gp.holder_count) : null,
    aggregateLiquidityUsd: Math.round(aggLiquidityUsd),
    poolsCounted: base.length,
    priceUsd,
    marketCapUsd: marketCap ?? null,
    marketCapBasis: marketCap ? (base.some((p) => p.marketCap) ? "circulating" : "fdv") : null,
    topDumpableHolder: topHolder ? { address: topHolder.address, percentOfSupply: topHolder.percent, bagUsd: topBagUsd, isContract: topHolder.isContract } : null,
    top3DumpablePct: top3Pct,
    topHolderDumpImpactPct: topImpactPct, // selling the whole bag, conservative constant-product
    top3DumpImpactPct: top3ImpactPct,
    excludedAsNonDumpable: holders.filter((h) => !h.dumpable).map((h) => ({ address: h.address, percent: h.percent, tag: h.tag })),
    verdict, // resilient | absorbable | fragile | exit_trap | no_liquidity | unknown
    recommendation:
      verdict === "no_liquidity"
        ? "No DEX liquidity found — ANY sell craters the price and you likely can't exit at all. Treat as untradeable until a real pool exists."
        : verdict === "unknown"
          ? `Top live holder owns ${topHolder?.percent ?? "?"}% of supply over ${usd(aggLiquidityUsd)} liquidity, but no market cap is available to value the bag — can't quantify the dump. Treat concentration as unresolved.`
          : verdict === "resilient"
            ? `The largest live holder (${topHolder?.percent}%, ~${usd(topBagUsd)}) dumping would move price ~${topImpactPct}% against ${usd(aggLiquidityUsd)} of liquidity — the pool absorbs it. Healthy exit liquidity.`
            : verdict === "absorbable"
              ? `Largest live holder (${topHolder?.percent}%, ~${usd(topBagUsd)}) dumping ≈ ${topImpactPct}% impact; top 3 together ≈ ${top3ImpactPct}%. Absorbable but real — don't be the last one out if they start selling.`
              : verdict === "fragile"
                ? `⚠️ Largest live holder (${topHolder?.percent}%, ~${usd(topBagUsd)}) could move price ~${topImpactPct}% on exit; top 3 ≈ ${top3ImpactPct}%. Thin exit liquidity — a single whale sets the floor. Size small and watch these wallets.`
                : `🛑 EXIT TRAP: the largest live holder (${topHolder?.percent}%, ~${usd(topBagUsd)}) dumping is ~${topImpactPct}% impact against only ${usd(aggLiquidityUsd)} of liquidity. Their exit is your crater — this is where the bag-holder gets left. Avoid or treat as pure gamble.`,
    note: "Exit-liquidity read: GoPlus holder %s (pools / locked / burn excluded as non-dumpable) valued against DexScreener market cap, then dumped through aggregate pool liquidity with the conservative constant-product model price-impact uses. Heuristic — a locked bag can unlock, a contract holder may be a treasury that can sell. Not a price feed, not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
