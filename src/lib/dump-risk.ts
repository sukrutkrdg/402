/**
 * dump-risk — the exit-liquidity question every token-risk tool gestures at but
 * none quantifies: if the biggest holders sell, can the liquidity absorb it?
 *
 * "Top holder owns 18%" is meaningless without the other half: 18% of WHAT,
 * against how deep a pool. A 18% bag worth $40k over a $2M pool is nothing; the
 * same 18% worth $2M over a $300k pool is a trap where the holder's exit is YOUR
 * entry at a crater. This puts the two numbers together.
 *
 *   holders (GoPlus) → top holders, their % of supply, and what each one IS:
 *     a sourced protocol address (lending / DEX / bridge / locker / burn — see
 *     known-addresses.ts), one of this token's own pools, an ERC-4626 vault for
 *     it, an exchange wallet, an unknown contract or a plain wallet. Only the
 *     last three can actually dump; exchange wallets are pooled user funds and
 *     reported separately rather than treated as "the top holder".
 *   pools (DexScreener) → aggregate Base liquidity + market cap to value the bag.
 *   impact → the same conservative constant-product math price-impact uses, applied
 *     to the largest DUMPABLE non-exchange holder and to the top three combined.
 *
 * Heuristic and conservative; GoPlus %s and DexScreener snapshots. Not a price
 * feed, not financial advice.
 */

import "server-only";
import { getAddress } from "viem";
import { goPlusSecurity, dexTokenPairs } from "./upstream-cache";
import { labelHolder, type HolderClass } from "./known-addresses";
import { probeVaultsForToken } from "./address-probe";
import { USD_STABLES } from "./stablecoin-peg";

interface GpHolder { address?: string; tag?: string; is_contract?: number | string; is_locked?: number | string; percent?: string }
type Gp = Record<string, unknown> & { holders?: GpHolder[] };
interface Pair {
  pairAddress?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceUsd?: string;
  priceNative?: string;
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

interface Holder {
  address: string | null;
  percent: number;
  tag: string | null;
  isContract: boolean;
  dumpable: boolean;
  label: string;
  kind: HolderClass;
  source: string;
  reason: string;
}

export async function dumpRiskCore(params: Record<string, string>) {
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
  // A failed pool read is not an empty pool. Folding null into [] answered
  // "no_liquidity — untradeable" (and billed it) whenever DexScreener was down.
  if (pairs === null) throw new Error("Pool data unavailable (DexScreener) — not charged, retry shortly");

  const addrLc = address.toLowerCase();
  const base = (pairs || []).filter((p) => p?.baseToken?.address?.toLowerCase() === addrLc);
  // A token can be sold into every pool it sits in, including the ones where it
  // is the QUOTE side. Counting base-side pools only read USDC's exit liquidity
  // on Base as ~$0.45M when its quote-side pools held ~$47M (2026-10-14).
  const quote = (pairs || []).filter((p) => p?.quoteToken?.address?.toLowerCase() === addrLc);
  const aggLiquidityUsd = [...base, ...quote].reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  // Price from a base-side pool; else derive it from a quote-side one
  // (priceUsd is the base token's USD price, priceNative its price in the quote).
  const priceUsd =
    base.map((p) => Number(p.priceUsd)).find((n) => Number.isFinite(n) && n > 0) ??
    quote.map((p) => Number(p.priceUsd) / Number(p.priceNative)).find((n) => Number.isFinite(n) && n > 0) ??
    null;
  // GoPlus holder percentages are shares of the supply ON BASE, so a bag is
  // valued against Base supply × price. DexScreener's market cap is the token's
  // global figure — for a multichain token like USDC it was ~16× Base supply,
  // which inflated every bag by the same factor. Fall back to it only when the
  // Base supply is unknown.
  const baseSupply = num(gp.total_supply);
  const baseSupplyUsd = baseSupply > 0 && priceUsd ? baseSupply * priceUsd : null;
  const dexCap = base.map((p) => p.marketCap).find((n) => n && n > 0) ?? null;
  const dexFdv = base.map((p) => p.fdv).find((n) => n && n > 0) ?? null;
  const marketCap = baseSupplyUsd ?? dexCap ?? dexFdv ?? null;
  const marketCapBasis = baseSupplyUsd ? "base_supply" : dexCap ? "circulating" : dexFdv ? "fdv" : null;

  // Every pool this token sits in — as base OR quote — is the liquidity itself,
  // not a holder that can sell into it. (v4 pool ids are not addresses; v4
  // liquidity sits in the PoolManager, which the registry covers.)
  const pairAddresses = new Set(
    (pairs || [])
      .filter((p) => p?.baseToken?.address?.toLowerCase() === addrLc || p?.quoteToken?.address?.toLowerCase() === addrLc)
      .map((p) => (p.pairAddress ?? "").toLowerCase())
      .filter((a) => /^0x[0-9a-f]{40}$/.test(a)),
  );

  const rows = gp.holders.map((h) => {
    const addr = String(h.address ?? "").toLowerCase();
    const goPlusNonDumpable = isTrue(h.is_locked) || BURN.has(addr) || NON_DUMPABLE_TAG.test(h.tag ?? "");
    return { h, addr, goPlusNonDumpable, isContract: isTrue(h.is_contract) };
  });
  // A contract holder that is neither sourced nor one of this token's pools may
  // be an ERC-4626 vault for it. A failed read leaves it dumpable.
  const probe = rows
    .filter((r) => r.isContract && !r.goPlusNonDumpable && !pairAddresses.has(r.addr) && labelHolder(r.addr).kind === "wallet")
    .map((r) => r.addr);
  const vaultsForToken = probe.length ? await probeVaultsForToken(address, probe).catch(() => new Set<string>()) : new Set<string>();

  const holders: Holder[] = rows.map(({ h, addr, goPlusNonDumpable, isContract }) => {
    const l = labelHolder(addr, { pairAddresses, vaultsForToken, goPlusNonDumpable, goPlusTag: h.tag || null, isContract });
    return {
      address: h.address ?? null,
      percent: +(num(h.percent) * 100).toFixed(2),
      tag: h.tag || null,
      isContract,
      dumpable: !l.nonDumpable,
      label: l.label,
      kind: l.kind,
      source: l.source,
      reason: l.reason,
    };
  });

  // Exchange wallets stay dumpable — an exchange can sell deposits — but they
  // are many users' funds, not one holder's decision. The verdict is taken on
  // the largest NON-exchange dumpable holder; exchange share is context.
  const dumpableAll = holders.filter((h) => h.dumpable).sort((a, b) => b.percent - a.percent);
  const cexHolders = dumpableAll.filter((h) => h.kind === "cex");
  const cexPct = +cexHolders.reduce((s, h) => s + h.percent, 0).toFixed(2);
  const dumpable = dumpableAll.filter((h) => h.kind !== "cex");
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
  const who = topHolder ? `, ${topHolder.label}` : "";
  const cexNote = cexHolders.length
    ? ` Exchange wallets hold ${cexPct}% (${cexHolders.map((h) => h.label.replace(/ — cex \(pooled user funds\)$/, "")).join(", ")}) — pooled user funds, not counted as the top holder, though an exchange can sell deposits.`
    : "";
  const base_rec =
    verdict === "no_liquidity"
      ? "No DEX liquidity found — ANY sell craters the price and you likely can't exit at all. Treat as untradeable until a real pool exists."
      : verdict === "unknown"
        ? `Top live holder owns ${topHolder?.percent ?? "?"}% of supply over ${usd(aggLiquidityUsd)} liquidity, but no market cap is available to value the bag — can't quantify the dump. Treat concentration as unresolved.`
        : verdict === "resilient"
          ? `The largest live holder (${topHolder?.percent}%${who}, ~${usd(topBagUsd)}) dumping would move price ~${topImpactPct}% against ${usd(aggLiquidityUsd)} of liquidity — the pool absorbs it. Healthy exit liquidity.`
          : verdict === "absorbable"
            ? `Largest live holder (${topHolder?.percent}%${who}, ~${usd(topBagUsd)}) dumping ≈ ${topImpactPct}% impact; top 3 together ≈ ${top3ImpactPct}%. Absorbable but real — don't be the last one out if they start selling.`
            : verdict === "fragile"
              ? `⚠️ Largest live holder (${topHolder?.percent}%${who}, ~${usd(topBagUsd)}) could move price ~${topImpactPct}% on exit; top 3 ≈ ${top3ImpactPct}%. Thin exit liquidity — a single whale sets the floor. Size small and watch these wallets.`
              : `🛑 EXIT TRAP: the largest live holder (${topHolder?.percent}%${who}, ~${usd(topBagUsd)}) dumping is ~${topImpactPct}% impact against only ${usd(aggLiquidityUsd)} of liquidity. Their exit is your crater — this is where the bag-holder gets left. Avoid or treat as pure gamble.`;

  return {
    address,
    holderCount: gp.holder_count !== undefined ? Number(gp.holder_count) : null,
    aggregateLiquidityUsd: Math.round(aggLiquidityUsd),
    poolsCounted: base.length,
    priceUsd,
    marketCapUsd: marketCap ?? null,
    marketCapBasis, // base_supply (GoPlus Base supply × price) | circulating | fdv
    exitLiquiditySides: { baseSidePools: base.length, quoteSidePools: quote.length },
    topDumpableHolder: topHolder
      ? { address: topHolder.address, percentOfSupply: topHolder.percent, bagUsd: topBagUsd, isContract: topHolder.isContract, label: topHolder.label, kind: topHolder.kind }
      : null,
    top3DumpablePct: top3Pct,
    topHolderDumpImpactPct: topImpactPct, // selling the whole bag, conservative constant-product
    top3DumpImpactPct: top3ImpactPct,
    excludedAsNonDumpable: holders
      .filter((h) => !h.dumpable)
      .map((h) => ({ address: h.address, percent: h.percent, tag: h.tag, label: h.label, kind: h.kind, reason: h.reason, source: h.source })),
    // Exchange wallets: dumpable (the exchange can sell deposits) but pooled user
    // funds, so never "the top holder". Reported as context.
    cexHolders: cexHolders.map((h) => ({ address: h.address, percent: h.percent, label: h.label, source: h.source })),
    cexConcentrationPct: cexPct,
    // Every top holder with its label: a sourced registry name or a generic class
    // (dex pool / vault / unknown contract / unlabelled wallet) — never a guess.
    holderLabels: holders.map((h) => ({ address: h.address, percent: h.percent, label: h.label, kind: h.kind, dumpable: h.dumpable, source: h.source })),
    verdict, // resilient | absorbable | fragile | exit_trap | no_liquidity | unknown
    recommendation: verdict === "no_liquidity" ? base_rec : base_rec + cexNote,
    note: "Exit-liquidity read: GoPlus holder %s valued against DexScreener market cap, then dumped through aggregate pool liquidity with the conservative constant-product model price-impact uses. Excluded as non-dumpable: this token's own pools, sourced lending/DEX/bridge/locker/burn addresses (known-address registry, source per holder), ERC-4626 vaults for this token and GoPlus-locked holders. Exchange wallets are reported separately; unknown contracts stay dumpable (a team multisig can sell). Heuristic — a locked bag can unlock. Not a price feed, not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

/** The USD stablecoin this address is, if any (USDC, USDT, DAI, USDbC on Base). */
export function usdStablecoin(address: string) {
  return USD_STABLES.find((s) => s.address.toLowerCase() === address.toLowerCase()) ?? null;
}

/**
 * Paid entry point. A redeemable USD stablecoin is not exited by selling a bag
 * into a DEX pool — the issuer redeems it 1:1, so "the top holder dumps it"
 * models nothing real (USDC read exit_trap on a holder share of its Base
 * supply). Its exit risk is the peg, which stablecoin-peg measures.
 */
export async function dumpRisk(params: Record<string, string>) {
  const raw = (params.address || params.token || "").trim();
  const stable = validAddr(raw) ? usdStablecoin(raw) : null;
  if (stable) {
    return {
      address: getAddress(raw),
      verdict: "not_applicable" as const,
      stablecoin: stable.symbol,
      recommendation: `${stable.symbol} is a redeemable USD stablecoin: holders exit through the issuer, not by selling into DEX pools, so a whale-dump model doesn't apply. Its exit risk is the peg — check stablecoin-peg.`,
      checkedAt: new Date().toISOString(),
    };
  }
  return dumpRiskCore(params);
}
