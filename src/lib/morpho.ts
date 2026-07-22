/**
 * Morpho Position Health — is this Morpho Blue position about to be liquidated?
 *
 * Morpho Blue is the largest lending venue on Base (singleton
 * 0xBBBB...EFFCb). A position liquidates when its LTV crosses the market's LLTV;
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
import { cdpSql } from "./covalent";
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
// Fallback decimals when a token's on-chain decimals() read fails, so displayed
// amounts don't render at the wrong scale (18) for 6/8-decimal assets.
const KNOWN_DECIMALS: Record<string, number> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6, // USDC
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": 8, // cbBTC
  "0x4200000000000000000000000000000000000006": 18, // WETH
};

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
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("Provide a valid 0x... wallet address (wallet=)");
  const user = getAddress(wallet);

  const market = (params.market || params.id || DEFAULT_MARKET).trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(market)) throw new Error("market= must be a 32-byte Morpho market id (0x... 64 hex). Omit it to use the cbBTC/USDC market.");
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
  // A 0 oracle price (stale/unavailable feed) would zero collateralValue and make
  // every position read as liquidatable — refuse to price rather than lie.
  if (price === 0n) {
    throw new Error("Market oracle returned 0 (stale/unavailable) — can't price collateral right now; try again shortly.");
  }
  const loanDecimals = typeof res[3].result === "number" ? res[3].result : (KNOWN_DECIMALS[loanToken.toLowerCase()] ?? 18);
  const collDecimals = typeof res[4].result === "number" ? res[4].result : (KNOWN_DECIMALS[collateralToken.toLowerCase()] ?? 18);
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

/** Health for one position given the shared market context — used by the feed. */
function positionHealth(collateral: bigint, borrowShares: bigint, tBorrowA: bigint, tBorrowS: bigint, price: bigint, lltv: bigint) {
  const borrowed = toAssetsUp(borrowShares, tBorrowA, tBorrowS);
  const collateralValue = (collateral * price) / ORACLE_SCALE;
  const maxBorrow = (collateralValue * lltv) / WAD;
  const health = borrowed > 0n ? Number((maxBorrow * 10000n) / borrowed) / 10000 : Infinity;
  const ltvPct = collateralValue > 0n ? Number((borrowed * 10000n) / collateralValue) / 100 : 0;
  const dropToLiq = health > 1 ? +((1 - 1 / health) * 100).toFixed(2) : 0;
  return { borrowed, health, ltvPct, dropToLiq };
}

/**
 * Morpho Liquidation Feed — which Base Morpho positions are liquidatable right
 * now (or one small move away). Built for liquidator / MEV searchers: the data
 * directly makes them money, so it's the highest willingness-to-pay read on the
 * platform, and nobody else in the catalog serves it. Reconstructs the active
 * borrower set from Borrow events (CDP SQL), then prices every position onchain
 * in one multicall and ranks by health. Not financial advice.
 */
export async function morphoLiquidations(params: Record<string, string>) {
  const market = (params.market || params.id || DEFAULT_MARKET).trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(market)) throw new Error("market= must be a 32-byte Morpho market id (0x... 64 hex). Omit it to use the cbBTC/USDC market.");
  const id = market as `0x${string}`;
  // Health cutoff: report positions at or below this (1.0 = already liquidatable).
  const maxHealth = Math.min(2, Math.max(1, Number(params.maxHealth || params.threshold || "1.1") || 1.1));

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

  // Active borrower set: onBehalf from Borrow events on THIS market over 90 days.
  // Borrow(Id indexed id, ..., address indexed onBehalf, ...): the market id is the
  // first indexed arg, so it lands in topics[2] (ClickHouse 1-indexed, topic0 =
  // signature at [1]). Filtering there scopes the scan to the requested market;
  // the decoded parameters.id comes back as raw bytes (unusable as hex), so we
  // never match on it. id is regex-validated above, safe to interpolate.
  const rows = await cdpSql<{ parameters?: Record<string, unknown> }>(
    `SELECT parameters FROM base.events WHERE address = '${MORPHO_BLUE.toLowerCase()}' AND event_name = 'Borrow' AND topics[2] = '${id}' AND block_timestamp > now() - INTERVAL 90 DAY ORDER BY block_timestamp DESC LIMIT 800`,
  );
  if (rows === null) throw new Error("Morpho borrower data unavailable (data provider) — try again shortly");
  // Cap the scan at the 60 most-recently-active borrowers. This keeps the whole
  // handler (one multicall of ~66 reads + settlement) fast enough for the x402
  // paid path — a heavier 200-position scan settles fine on the credit path but
  // is too slow for x402 verify+settle in one request. Recently-active borrowers
  // are also the ones most likely to be at the edge.
  const SCAN_CAP = 60;
  const borrowers: `0x${string}`[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const ob = r.parameters?.onBehalf;
    if (typeof ob === "string" && /^0x[0-9a-fA-F]{40}$/.test(ob)) {
      const a = getAddress(ob);
      if (!seen.has(a)) { seen.add(a); borrowers.push(a as `0x${string}`); }
    }
    if (borrowers.length >= SCAN_CAP) break;
  }

  // Price every position in one multicall (market totals + oracle + N positions + token metadata).
  const contracts = [
    { address: MORPHO_BLUE, abi: morphoAbi, functionName: "market", args: [id] } as const,
    { address: oracle as `0x${string}`, abi: oracleAbi, functionName: "price" } as const,
    { address: loanToken as `0x${string}`, abi: erc20Abi, functionName: "decimals" } as const,
    { address: collateralToken as `0x${string}`, abi: erc20Abi, functionName: "decimals" } as const,
    { address: loanToken as `0x${string}`, abi: erc20Abi, functionName: "symbol" } as const,
    { address: collateralToken as `0x${string}`, abi: erc20Abi, functionName: "symbol" } as const,
    ...borrowers.map((u) => ({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "position", args: [id, u] } as const)),
  ];
  const res = await client.multicall({ allowFailure: true, contracts });
  const mk = res[0].result as readonly [bigint, bigint, bigint, bigint, bigint, bigint] | undefined;
  const price = res[1].result as bigint | undefined;
  if (!mk || price === undefined) throw new Error("Morpho market/oracle read failed — try again shortly");
  // A 0 oracle price would flip every borrower to "liquidatable" — refuse rather
  // than emit a false liquidation feed to searchers.
  if (price === 0n) throw new Error("Market oracle returned 0 (stale/unavailable) — can't price this market right now; try again shortly.");
  const loanDecimals = typeof res[2].result === "number" ? res[2].result : 18;
  const collDecimals = typeof res[3].result === "number" ? res[3].result : 18;
  const loanSymbol = typeof res[4].result === "string" ? res[4].result : "loan";
  const collSymbol = typeof res[5].result === "string" ? res[5].result : "collateral";
  const [, , tBorrowA, tBorrowS] = mk;

  const positions = borrowers.map((wallet, i) => {
    const pos = res[6 + i].result as readonly [bigint, bigint, bigint] | undefined;
    if (!pos) return null;
    const [, borrowShares, collateral] = pos;
    if (borrowShares === 0n) return null; // repaid / never borrowed on this market
    const h = positionHealth(collateral, borrowShares, tBorrowA, tBorrowS, price, lltv);
    if (h.health > maxHealth) return null;
    return {
      wallet,
      status: h.health <= 1 ? "liquidatable" : "at_risk",
      healthFactor: +h.health.toFixed(4),
      currentLtvPct: +h.ltvPct.toFixed(2),
      priceDropToLiquidationPct: h.dropToLiq,
      collateral: fmt(collateral, collDecimals),
      borrowed: fmt(h.borrowed, loanDecimals),
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.healthFactor - b.healthFactor);

  const liquidatable = positions.filter((p) => p.status === "liquidatable");

  return finish({
    market: id,
    pair: `${collSymbol}/${loanSymbol}`,
    liquidationLtvPct: +(Number(lltv / 10n ** 14n) / 100).toFixed(2),
    scannedBorrowers: borrowers.length,
    healthCutoff: maxHealth,
    liquidatableCount: liquidatable.length,
    atRiskCount: positions.length - liquidatable.length,
    positions: positions.slice(0, 30),
    verdict: liquidatable.length ? "liquidatable_now" : positions.length ? "watch" : "none",
    recommendation: liquidatable.length
      ? `${liquidatable.length} position(s) are liquidatable RIGHT NOW (health <= 1.0) on the ${collSymbol}/${loanSymbol} market — call Morpho's liquidate(marketParams, borrower, ...) to seize collateral at the incentive. ${positions.length - liquidatable.length} more within ${maxHealth}x health.`
      : positions.length
        ? `No positions are liquidatable yet, but ${positions.length} sit within ${maxHealth}x health — a small ${collSymbol} price drop puts the closest (${positions[0].priceDropToLiquidationPct}% away) in range. Poll to catch the crossover.`
        : `No ${collSymbol}/${loanSymbol} positions under ${maxHealth}x health among the ${borrowers.length} most recent borrowers. Nothing to liquidate right now.`,
    note: "Live liquidation feed for a Base Morpho Blue market: active borrowers ranked by liquidation health, flagging positions liquidatable now (health <= 1.0) and those close. Reconstructed from Borrow events + onchain pricing over the 60 most-recently-active borrowers. market= optional (defaults cbBTC/USDC); maxHealth= cutoff (default 1.1). Not financial advice.",
  });
}
