/**
 * Morpho Position Health — is this Morpho Blue position about to be liquidated?
 *
 * Morpho Blue is the largest lending venue on Base (singleton
 * 0xBBBB…EFFCb). A position liquidates when its LTV crosses the market's LLTV;
 * borrowers (and the agents/treasuries managing them) need one call that answers
 * "how close am I, and how far can the collateral price fall before I'm cut."
 * The catalog had zero lending tooling and Morpho's own API is deferred — this
 * is the first read of that surface. Pure onchain reads, no upstream. Not
 * financial advice.
 *
 * Health math (Morpho Blue, Health.sol):
 *   borrowed        = borrowShares · totalBorrowAssets / totalBorrowShares (up)
 *   collateralValue = collateral · oraclePrice / 1e36        (loan-token units)
 *   maxBorrow       = collateralValue · lltv / 1e18
 *   healthy iff maxBorrow ≥ borrowed  →  healthFactor = maxBorrow / borrowed
 */

import "server-only";
import { createPublicClient, getAddress } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { finish } from "./envelope";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

export const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;
// Default market so an agent can probe with just wallet=: cbBTC (collateral) / USDC (loan).
const DEFAULT_MARKET = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";

const morphoAbi = [
  { type: "function", name: "idToMarketParams", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" }, { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" }] },
  { type: "function", name: "position", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }, { name: "user", type: "address" }], outputs: [{ name: "supplyShares", type: "uint256" }, { name: "borrowShares", type: "uint128" }, { name: "collateral", type: "uint128" }] },
  { type: "function", name: "market", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "totalSupplyAssets", type: "uint128" }, { name: "totalSupplyShares", type: "uint128" }, { name: "totalBorrowAssets", type: "uint128" }, { name: "totalBorrowShares", type: "uint128" }, { name: "lastUpdate", type: "uint128" }, { name: "fee", type: "uint128" }] },
] as const;
const oracleAbi = [{ type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const ORACLE_SCALE = 10n ** 36n;
const WAD = 10n ** 18n;

/** shares → assets, rounding up (matches Morpho's toAssetsUp for debt). */
function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  if (totalShares === 0n) return 0n;
  return (shares * totalAssets + (totalShares - 1n)) / totalShares;
}

function fmt(v: bigint, decimals: number): string {
  const d = BigInt(decimals);
  const base10 = 10n ** d;
  const whole = v / base10;
  const frac = v % base10;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

export async function morphoHealth(params: Record<string, string>) {
  const wallet = (params.wallet || params.user || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("Provide a valid 0x… wallet address (wallet=)");
  const user = getAddress(wallet);

  const market = (params.market || params.id || DEFAULT_MARKET).trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(market)) throw new Error("market= must be a 32-byte Morpho market id (0x… 64 hex). Omit it to use the cbBTC/USDC market.");
  const id = market as `0x${string}`;

  // 1) Resolve market params (need the oracle address before we can price collateral).
  let mp: readonly [string, string, string, string, bigint];
  try {
    mp = await client.readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "idToMarketParams", args: [id] });
  } catch {
    throw new Error("Morpho read unavailable (RPC) — try again shortly");
  }
  const [loanToken, collateralToken, oracle, , lltv] = mp;
  if (lltv === 0n || loanToken === "0x0000000000000000000000000000000000000000") {
    throw new Error(`Unknown Morpho market id ${id} — no market with those params exists on Base.`);
  }

  // 2) Batch the rest in one multicall (position, market totals, price, token metadata).
  const res = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: MORPHO_BLUE, abi: morphoAbi, functionName: "position", args: [id, user] },
      { address: MORPHO_BLUE, abi: morphoAbi, functionName: "market", args: [id] },
      { address: oracle as `0x${string}`, abi: oracleAbi, functionName: "price" },
      { address: loanToken as `0x${string}`, abi: erc20Abi, functionName: "decimals" },
      { address: collateralToken as `0x${string}`, abi: erc20Abi, functionName: "decimals" },
      { address: loanToken as `0x${string}`, abi: erc20Abi, functionName: "symbol" },
      { address: collateralToken as `0x${string}`, abi: erc20Abi, functionName: "symbol" },
    ],
  });
  const pos = res[0].result as readonly [bigint, bigint, bigint] | undefined;
  const mk = res[1].result as readonly [bigint, bigint, bigint, bigint, bigint, bigint] | undefined;
  const price = res[2].result as bigint | undefined;
  if (!pos || !mk || price === undefined) {
    throw new Error("Morpho position/oracle read failed — try again shortly");
  }
  const loanDecimals = typeof res[3].result === "number" ? res[3].result : 18;
  const collDecimals = typeof res[4].result === "number" ? res[4].result : 18;
  const loanSymbol = typeof res[5].result === "string" ? res[5].result : "loan";
  const collSymbol = typeof res[6].result === "string" ? res[6].result : "collateral";

  const [, borrowShares, collateral] = pos;
  const [, , totalBorrowAssets, totalBorrowShares, lastUpdate] = mk;

  // No debt → not liquidatable regardless of collateral.
  if (borrowShares === 0n) {
    return finish({
      wallet: user,
      market: id,
      pair: `${collSymbol}/${loanSymbol}`,
      verdict: "no_borrow",
      collateral: fmt(collateral, collDecimals),
      collateralToken: getAddress(collateralToken),
      borrowed: "0",
      recommendation: collateral > 0n
        ? `This wallet supplies ${fmt(collateral, collDecimals)} ${collSymbol} as collateral but has NO outstanding borrow in this market — nothing to liquidate.`
        : "This wallet has no position (no collateral, no borrow) in this market.",
      note: "Reads a Morpho Blue lending position on Base and its liquidation health. Pass wallet= and (optionally) market=; omit market= for cbBTC/USDC. Not financial advice.",
    });
  }

  const borrowed = toAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares);
  const collateralValue = (collateral * price) / ORACLE_SCALE; // in loan-token base units
  const maxBorrow = (collateralValue * lltv) / WAD;

  // Fixed-point ratios via bigint to avoid float blow-up on large positions.
  const healthBps = borrowed > 0n ? (maxBorrow * 10000n) / borrowed : 0n;
  const health = Number(healthBps) / 10000;
  const ltvBps = collateralValue > 0n ? (borrowed * 10000n) / collateralValue : 0n;
  const currentLtvPct = Number(ltvBps) / 100;
  const lltvPct = Number(lltv / 10n ** 14n) / 100;
  // How far the collateral price can fall before liquidation (maxBorrow ∝ price).
  const priceDropToLiqPct = health > 1 ? +((1 - 1 / health) * 100).toFixed(2) : 0;

  const verdict =
    health <= 1 ? "liquidatable"
    : health < 1.05 ? "critical"
    : health < 1.15 ? "at_risk"
    : health < 1.5 ? "moderate"
    : "healthy";

  return finish({
    wallet: user,
    market: id,
    pair: `${collSymbol}/${loanSymbol}`,
    verdict, // healthy | moderate | at_risk | critical | liquidatable | no_borrow
    healthFactor: +health.toFixed(4),
    currentLtvPct: +currentLtvPct.toFixed(2),
    liquidationLtvPct: +lltvPct.toFixed(2),
    priceDropToLiquidationPct: priceDropToLiqPct, // % drop in collateral price that triggers liquidation
    collateral: fmt(collateral, collDecimals),
    collateralToken: getAddress(collateralToken),
    borrowed: fmt(borrowed, loanDecimals),
    loanToken: getAddress(loanToken),
    lastAccrual: new Date(Number(lastUpdate) * 1000).toISOString(),
    recommendation:
      verdict === "liquidatable"
        ? `🚨 LIQUIDATABLE NOW: LTV ${currentLtvPct.toFixed(1)}% ≥ liquidation LTV ${lltvPct.toFixed(1)}%. Repay ${loanSymbol} or add ${collSymbol} collateral immediately, or expect liquidation.`
        : verdict === "critical"
          ? `⚠️ CRITICAL: a ${priceDropToLiqPct}% drop in ${collSymbol} price liquidates this position (health ${health.toFixed(3)}). Add collateral or repay now.`
          : verdict === "at_risk"
            ? `At risk: ${priceDropToLiqPct}% ${collSymbol} price drop to liquidation (health ${health.toFixed(3)}). Watch closely; consider deleveraging.`
            : verdict === "moderate"
              ? `Moderate buffer: ${collSymbol} can fall ${priceDropToLiqPct}% before liquidation (health ${health.toFixed(3)}).`
              : `Healthy: ${collSymbol} would need to fall ${priceDropToLiqPct}% to reach liquidation (health ${health.toFixed(3)}).`,
    note: "Morpho Blue liquidation-health read on Base: health factor, current vs liquidation LTV, and the collateral price drop that triggers liquidation. Borrowed amount reflects the last on-chain interest accrual (accrues slightly higher between blocks). wallet= required; market= optional (defaults to cbBTC/USDC). Not financial advice.",
  });
}
