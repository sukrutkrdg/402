/**
 * stock-collateral-risk — what happens to a tokenized-stock loan when the US
 * market reopens.
 *
 * Aave V4's Equities Hub on Base lets a wallet post Coinbase tokenized stocks
 * (AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, TSLAc) and borrow USDC. Its oracle
 * is Chainlink's 24/5 equity feed, which holds its last value from Friday 20:00 ET
 * to Sunday 20:00 ET. So over a weekend the health factor cannot fall on price —
 * the stock tokens keep trading on Base DEXs, but the loan does not see it — and
 * whatever drift has built up lands at once when the feed resumes.
 *
 * Measured on 2026-10-17 (a Saturday): 53 open borrowers, many between HF 1.05
 * and 1.2, and four liquidations to date — the first at 10:15 ET, 45 minutes
 * after the opening bell.
 *
 * The weekend DEX price is the market's live guess at the reopen. This re-prices
 * each collateral at it and reports the projected health factor, and the move
 * that would liquidate the position. The protocol's own health factor is the
 * anchor: we recompute it from the same inputs (supplied × oracle price ×
 * the user's collateral factor ÷ debt), check that it matches, and scale each
 * collateral by DEX ÷ oracle.
 *
 * Read-only; addresses from aave-dao/aave-address-book (AaveV4Base).
 */

import "server-only";
import { createPublicClient, getAddress, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { dexTokenPairs } from "./upstream-cache";
import { deepestPool, type DexPoolLike } from "./dex-pool";
import { findStock } from "./tokenized-stocks";
import { readStockActions } from "./stock-corporate-actions";
import { marketSession, hoursUntilReopen } from "./stock-fair-value";

export const AAVE_V4_BASE_MAG7_SPOKE: Address = "0x17905Db0e4A3514467539956c084180616AE7B8D";

const spokeAbi = parseAbi([
  "function getReserveCount() view returns (uint256)",
  "function getReserve(uint256) view returns ((address underlying, address hub, uint16 assetId, uint8 decimals, uint24 collateralRisk, uint8 flags, uint32 dynamicConfigKey))",
  "function getReserveConfig(uint256) view returns ((uint24 collateralRisk, bool paused, bool frozen, bool borrowable, bool receiveSharesEnabled))",
  "function getDynamicReserveConfig(uint256, uint32) view returns ((uint16 collateralFactor, uint32 maxLiquidationBonus, uint16 liquidationFee))",
  "function getUserAccountData(address) view returns ((uint256 riskPremium, uint256 avgCollateralFactor, uint256 healthFactor, uint256 totalCollateralValue, uint256 totalDebtValueRay, uint256 activeCollateralCount, uint256 borrowCount))",
  "function getUserSuppliedAssets(uint256, address) view returns (uint256)",
  "function getUserTotalDebt(uint256, address) view returns (uint256)",
  "function getUserReserveStatus(uint256, address) view returns (bool, bool)",
  "function getUserPosition(uint256, address) view returns ((uint120 drawnShares, uint120 premiumShares, int200 premiumOffsetRay, uint120 suppliedShares, uint32 dynamicConfigKey))",
  "function ORACLE() view returns (address)",
]);
const oracleAbi = parseAbi(["function getReservesPrices(uint256[]) view returns (uint256[])", "function decimals() view returns (uint8)"]);

export interface CollateralLeg {
  reserveId: number;
  token: string;
  symbol: string;
  amount: number;
  /** USD per token at the protocol's oracle. */
  oraclePrice: number;
  /** USD per token on the deepest Base pool, or null when it cannot be read. */
  dexPrice: number | null;
  /** The user's collateral factor for this reserve, 0–1. */
  collateralFactor: number;
  valueUsd: number;
  paused: boolean;
}

/**
 * Projected health factor when each collateral is re-priced from oracle to DEX.
 * HF = Σ(value × CF) / debt, so the projection scales each weighted leg by
 * dex/oracle; a leg with no DEX price keeps its oracle value. Pure.
 */
export function projectHealth(hf: number, legs: readonly Pick<CollateralLeg, "valueUsd" | "collateralFactor" | "oraclePrice" | "dexPrice">[]): number | null {
  const weighted = legs.reduce((s, l) => s + l.valueUsd * l.collateralFactor, 0);
  if (!(weighted > 0) || !Number.isFinite(hf)) return null;
  const moved = legs.reduce((s, l) => s + l.valueUsd * l.collateralFactor * (l.dexPrice && l.oraclePrice > 0 ? l.dexPrice / l.oraclePrice : 1), 0);
  return hf * (moved / weighted);
}

/** The uniform collateral move, in %, that takes `hf` to exactly 1. Pure. */
export function dropToLiquidation(hf: number | null): number | null {
  if (hf === null || !Number.isFinite(hf) || hf <= 0) return null;
  return Math.round((1 - 1 / hf) * 10_000) / 100;
}

export type RiskBand = "liquidatable" | "critical" | "at_risk" | "watch" | "safe" | "no_debt";

/** Band a health factor. Pure. */
export function riskBand(hf: number | null, hasDebt: boolean): RiskBand {
  if (!hasDebt || hf === null) return "no_debt";
  if (hf < 1) return "liquidatable";
  if (hf < 1.05) return "critical";
  if (hf < 1.15) return "at_risk";
  if (hf < 1.4) return "watch";
  return "safe";
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export async function stockCollateralRisk(params: Record<string, string>) {
  const raw = (params.wallet || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide wallet= (the borrower's address)");
  const user = getAddress(raw);
  const c = createPublicClient({ chain: base, transport: baseTransport(8000) });
  const S = AAVE_V4_BASE_MAG7_SPOKE;

  let account, count: bigint, oracle: Address;
  try {
    [account, count, oracle] = await Promise.all([
      c.readContract({ address: S, abi: spokeAbi, functionName: "getUserAccountData", args: [user] }),
      c.readContract({ address: S, abi: spokeAbi, functionName: "getReserveCount" }),
      c.readContract({ address: S, abi: spokeAbi, functionName: "ORACLE" }),
    ]);
  } catch {
    throw new Error("Aave V4 (Base) unreadable this call — not charged, retry shortly");
  }
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
  const now = new Date();
  const session = marketSession(now);
  const hasDebt = account.borrowCount > 0n && account.totalDebtValueRay > 0n;

  if (account.activeCollateralCount === 0n && !hasDebt) {
    return {
      wallet: user,
      protocol: "Aave V4 — Base Equities Hub (Mag7 spoke)",
      spoke: S,
      band: "no_debt" as RiskBand,
      session,
      note: "This wallet has no collateral or debt in Aave V4's Base equities market. Not financial advice.",
      checkedAt: now.toISOString(),
    };
  }

  const mc = <T>(contracts: unknown[]) => c.multicall({ contracts: contracts as never, allowFailure: false }) as Promise<T[]>;
  const [reserves, configs, supplied, debts, statuses, positions, prices, oracleDec] = await Promise.all([
    mc<{ underlying: Address; decimals: number; dynamicConfigKey: number }>(ids.map((id) => ({ address: S, abi: spokeAbi, functionName: "getReserve", args: [id] }))),
    mc<{ paused: boolean; frozen: boolean }>(ids.map((id) => ({ address: S, abi: spokeAbi, functionName: "getReserveConfig", args: [id] }))),
    mc<bigint>(ids.map((id) => ({ address: S, abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [id, user] }))),
    mc<bigint>(ids.map((id) => ({ address: S, abi: spokeAbi, functionName: "getUserTotalDebt", args: [id, user] }))),
    mc<readonly [boolean, boolean]>(ids.map((id) => ({ address: S, abi: spokeAbi, functionName: "getUserReserveStatus", args: [id, user] }))),
    mc<{ dynamicConfigKey: number }>(ids.map((id) => ({ address: S, abi: spokeAbi, functionName: "getUserPosition", args: [id, user] }))),
    c.readContract({ address: oracle, abi: oracleAbi, functionName: "getReservesPrices", args: [ids] }),
    c.readContract({ address: oracle, abi: oracleAbi, functionName: "decimals" }),
  ]).catch(() => {
    throw new Error("Aave V4 (Base) position unreadable this call — not charged, retry shortly");
  });

  const pDiv = 10 ** Number(oracleDec);
  // The user's own collateral factors (their dynamic config snapshot).
  const cfs = await mc<{ collateralFactor: number }>(
    ids.map((id, i) => ({ address: S, abi: spokeAbi, functionName: "getDynamicReserveConfig", args: [id, positions[i].dynamicConfigKey] })),
  ).catch(() => null);

  const collateralIdx = ids.map((_, i) => i).filter((i) => supplied[i] > 0n && statuses[i][0]);
  const legs: CollateralLeg[] = await Promise.all(
    collateralIdx.map(async (i) => {
      const token = reserves[i].underlying.toLowerCase();
      const stock = await findStock(token);
      const amount = Number(supplied[i]) / 10 ** reserves[i].decimals;
      const oraclePrice = Number(prices[i]) / pDiv;
      const pairs = await dexTokenPairs<DexPoolLike>(token).catch(() => null);
      const deep = pairs ? deepestPool(pairs, token) : null;
      return {
        reserveId: i,
        token: getAddress(token),
        symbol: stock?.sym ?? token,
        amount,
        oraclePrice,
        dexPrice: deep?.priceUsd ?? null,
        collateralFactor: cfs ? cfs[i].collateralFactor / 10_000 : 0,
        valueUsd: amount * oraclePrice,
        paused: configs[i].paused,
      };
    }),
  );

  const debtUsd = Number(account.totalDebtValueRay / 10n ** 27n) / pDiv / 1e18;
  const debtLegs = ids
    .map((_, i) => i)
    .filter((i) => debts[i] > 0n)
    .map((i) => ({ reserveId: i, token: getAddress(reserves[i].underlying), amount: Number(debts[i]) / 10 ** reserves[i].decimals, paused: configs[i].paused }));

  const hf = hasDebt ? Number(account.healthFactor) / 1e18 : null;
  // Our recomputation must agree with the protocol before we project from it.
  const weighted = legs.reduce((s, l) => s + l.valueUsd * l.collateralFactor, 0);
  const recomputed = hasDebt && debtUsd > 0 ? weighted / debtUsd : null;
  const consistent = hf !== null && recomputed !== null && Math.abs(recomputed / hf - 1) < 0.02;

  const projected = hf !== null && consistent ? projectHealth(hf, legs) : null;
  const bandNow = riskBand(hf, hasDebt);
  const bandAtReopen = projected !== null ? riskBand(projected, hasDebt) : null;
  const frozen = session === "closed";

  const actions = await readStockActions(
    legs.map((l) => ({ sym: l.symbol, ticker: l.symbol.replace(/c$/, ""), name: l.symbol, token: l.token.toLowerCase() as `0x${string}` })),
  ).catch(() => null);
  const announced = (actions ?? []).filter((a) => a.status === "announced");

  const warnings: string[] = [];
  if (frozen) warnings.push(`US market closed: the oracle is frozen at Friday's close and resumes in ~${hoursUntilReopen(now)} h (Sunday 20:00 ET). Until then your health factor moves only with interest; at the reopen it jumps to the market.`);
  if (bandAtReopen && bandAtReopen !== bandNow) warnings.push(`At today's Base DEX prices your health factor would be ${round(projected!, 3)} (${bandAtReopen}) the moment the oracle catches up, versus ${round(hf!, 3)} now.`);
  if (hf !== null && hf < 1.15) warnings.push(`A ${dropToLiquidation(projected ?? hf)}% fall in your collateral liquidates you. Liquidators restore you to HF 1.24 and take up to a 5.5% bonus.`);
  for (const l of legs) if (l.paused) warnings.push(`${l.symbol} reserve is PAUSED (a corporate action is being applied): you cannot supply, withdraw or repay against it until it resumes.`);
  for (const a of announced) warnings.push(`${a.symbol}: ${a.description} announced ${a.announcedAt ?? ""}. When Coinbase applies it, Aave pauses this reserve (no repay or withdraw) until the new multiplier is in.`);
  if (hasDebt && !consistent) warnings.push("Our recomputed health factor did not match the protocol's within 2%, so no projection is given — the protocol's own figure is shown.");

  return {
    wallet: user,
    protocol: "Aave V4 — Base Equities Hub (Mag7 spoke)",
    spoke: S,
    session,
    oracleFrozen: frozen,
    healthFactor: hf !== null ? round(hf) : null,
    band: bandNow,
    projectedHealthFactorAtReopen: projected !== null ? round(projected) : null,
    bandAtReopen,
    dropToLiquidationPct: dropToLiquidation(projected ?? hf),
    collateralUsd: round(legs.reduce((s, l) => s + l.valueUsd, 0), 2),
    debtUsd: round(debtUsd, 2),
    collateral: legs.map((l) => ({
      ...l,
      amount: round(l.amount, 6),
      valueUsd: round(l.valueUsd, 2),
      dexVsOracleBps: l.dexPrice ? Math.round((l.dexPrice / l.oraclePrice - 1) * 10_000) : null,
      liquidationPriceIfAlone: hf !== null && legs.length === 1 ? round(l.oraclePrice / hf, 4) : null,
    })),
    debt: debtLegs,
    announcedCorporateActions: announced.map((a) => ({ symbol: a.symbol, description: a.description, announcedAt: a.announcedAt })),
    warnings,
    note: "Aave V4 equities loan on Base, re-priced at the live Base DEX price — the market's guess at where the 24/5 oracle lands when it resumes. Health factor bands: <1 liquidatable, <1.05 critical, <1.15 at risk, <1.4 watch. Read-only. Not financial advice.",
    checkedAt: now.toISOString(),
  };
}
