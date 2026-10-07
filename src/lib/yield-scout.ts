/**
 * Yield scout — where should an agent's idle USDC sit on Base?
 *
 * Every pre-funded agent wallet carries idle USDC float so it can pay on demand,
 * and multiplied across a fleet that is real money earning nothing (the GENIUS
 * Act bars stablecoin issuers from paying interest, so the cash is a drag). The
 * autonomous answer DAOs already run by hand is: watch the lending markets and
 * park idle cash in the best one. This reads the live supply rate for USDC across
 * Base's major money markets and returns the best, with the annual yield on a
 * given balance so an agent can decide whether moving is worth the gas.
 *
 * Rates are read straight from each protocol, not a feed:
 *   - Aave v3 Pool.getReserveData().currentLiquidityRate (ray, already an APR).
 *   - Moonwell mToken.supplyRatePerTimestamp (per-second, 1e18) × seconds/year.
 * A venue whose read fails is reported as "unknown" and is NOT eligible to be the
 * recommended best — a money market we could not read cannot be where we send
 * funds. Verified live on Base 2026-10-07 (Aave ~3.8%, Moonwell ~14.8%).
 */

import "server-only";
import { createPublicClient, getAddress } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SECONDS_PER_YEAR = 31_536_000;
const RAY = 10n ** 27n;
const WAD = 10n ** 18n;

const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const AAVE_ABI = [
  {
    type: "function", name: "getReserveData", stateMutability: "view", inputs: [{ type: "address" }],
    outputs: [{
      type: "tuple", components: [
        { name: "configuration", type: "uint256" }, { name: "liquidityIndex", type: "uint128" },
        { name: "currentLiquidityRate", type: "uint128" }, { name: "variableBorrowIndex", type: "uint128" },
        { name: "currentVariableBorrowRate", type: "uint128" }, { name: "currentStableBorrowRate", type: "uint128" },
        { name: "lastUpdateTimestamp", type: "uint40" }, { name: "id", type: "uint16" },
        { name: "aTokenAddress", type: "address" }, { name: "stableDebtTokenAddress", type: "address" },
        { name: "variableDebtTokenAddress", type: "address" }, { name: "interestRateStrategyAddress", type: "address" },
        { name: "accruedToTreasury", type: "uint128" }, { name: "unbacked", type: "uint128" }, { name: "isolationModeTotalDebt", type: "uint128" },
      ],
    }],
  },
] as const;

const MOONWELL_USDC = "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22";
const MOONWELL_ABI = [
  { type: "function", name: "supplyRatePerTimestamp", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

interface Venue { protocol: string; market: string; aprPct: number | null }

async function readAave(): Promise<Venue> {
  try {
    const d = (await client.readContract({ address: getAddress(AAVE_POOL), abi: AAVE_ABI, functionName: "getReserveData", args: [getAddress(USDC)] })) as { currentLiquidityRate: bigint };
    // currentLiquidityRate is a ray-scaled APR already (per-year).
    const aprPct = Number((d.currentLiquidityRate * 1_000_000n) / RAY) / 1_000_000 * 100;
    return { protocol: "Aave v3", market: "USDC", aprPct: +aprPct.toFixed(2) };
  } catch {
    return { protocol: "Aave v3", market: "USDC", aprPct: null };
  }
}

async function readMoonwell(): Promise<Venue> {
  try {
    const r = (await client.readContract({ address: getAddress(MOONWELL_USDC), abi: MOONWELL_ABI, functionName: "supplyRatePerTimestamp" })) as bigint;
    // per-second, 1e18-scaled → simple APR × seconds/year.
    const aprPct = Number((r * 1_000_000n) / WAD) / 1_000_000 * SECONDS_PER_YEAR * 100;
    return { protocol: "Moonwell", market: "USDC", aprPct: +aprPct.toFixed(2) };
  } catch {
    return { protocol: "Moonwell", market: "USDC", aprPct: null };
  }
}

export async function yieldScout(params: Record<string, string>) {
  const amountStr = (params.amount || params.usd || "").trim();
  const amount = amountStr ? Number(amountStr) : null;
  if (amountStr && (!Number.isFinite(amount) || (amount as number) < 0)) throw new Error("amount must be a non-negative number of USDC (your idle balance)");

  const venues = await Promise.all([readAave(), readMoonwell()]);
  const readable = venues.filter((v) => v.aprPct !== null) as Array<Venue & { aprPct: number }>;
  const unread = venues.filter((v) => v.aprPct === null).map((v) => v.protocol);

  // A venue we could not read is not eligible to be "best" — never send funds to
  // a rate we did not confirm.
  const best = readable.length ? readable.reduce((b, v) => (v.aprPct > b.aprPct ? v : b)) : null;

  const rows = venues
    .map((v) => ({
      protocol: v.protocol,
      market: v.market,
      aprPct: v.aprPct,
      ...(amount !== null && v.aprPct !== null ? { annualYieldUsd: +((amount * v.aprPct) / 100).toFixed(2) } : {}),
    }))
    .sort((a, b) => (b.aprPct ?? -1) - (a.aprPct ?? -1));

  return {
    asset: "USDC",
    chain: "base" as const,
    ...(amount !== null ? { amountUsd: amount } : {}),
    venues: rows,
    best: best ? { protocol: best.protocol, aprPct: best.aprPct, ...(amount !== null ? { annualYieldUsd: +((amount * best.aprPct) / 100).toFixed(2) } : {}) } : null,
    ...(unread.length ? { degraded: true, unreadable: unread } : {}),
    recommendation: best
      ? `Idle USDC earns most on ${best.protocol} right now (${best.aprPct}% APR${amount !== null ? `, ~$${((amount * best.aprPct) / 100).toFixed(2)}/yr on $${amount}` : ""}). ${amount !== null && amount < 500 ? "At this size, weigh the deposit/withdraw gas against the extra yield before moving." : "Supply rates move continuously and these are variable — re-check before and after moving, and keep enough liquid to pay as you go."}`
      : "No money-market rate could be read this call (RPC) — idle-cash options are UNKNOWN, not zero. Re-check.",
    note: "Live USDC supply APR across Base money markets (Aave v3, Moonwell), read straight from each protocol — not a feed. Rates are variable and change every block; a venue we couldn't read is excluded from 'best', never sent funds on an unconfirmed rate. Supplying carries smart-contract and liquidity risk. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
