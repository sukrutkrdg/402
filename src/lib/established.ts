/**
 * Is this an established token, whose admin controls are part of how it is run
 * rather than a launch-day rug setup?
 *
 * Why it exists: token-risk scored "owner not renounced", "mintable", "LP not
 * locked" and "upgradeable proxy" the same on every token. On a token launched an
 * hour ago those are the rug signals. On USDC, DEGEN or AERO they are how the
 * issuer runs it, so pre-trade-gate answered HOLD on USDC, its own published
 * example, and the gate that says HOLD to everything stops being asked.
 *
 * Established means BOTH of:
 *   - at least ESTABLISHED_HOLDERS holders (GoPlus holder_count), and
 *   - at least ESTABLISHED_LIQUIDITY_USD of DEX liquidity on Base, summed over
 *     the token's own Base pools (DexScreener).
 * Holder counts alone can be faked: airdrop spam reaches millions of addresses
 * for the cost of gas. Liquidity cannot be faked cheaply. Either signal missing
 * (feed down, no pools) means not established: the strict scoring stays.
 *
 * What it changes is narrow. Only ADMIN_FLAGS are demoted, from scored risk to
 * context. Honeypot, taxes, pausable transfers, hidden owners, reclaimable
 * ownership and blacklists are scored on every token, established or not.
 */

import "server-only";
import { dexTokenPairs } from "./upstream-cache";

export const ESTABLISHED_HOLDERS = 50_000;
export const ESTABLISHED_LIQUIDITY_USD = 1_000_000;

/** Flags that describe an issuer's admin controls. Rug signals on a fresh launch;
 *  context on an established token. Nothing else is ever demoted. */
export const ADMIN_FLAGS = ["owner_not_renounced", "mintable", "lp_not_locked", "upgradeable_proxy"] as const;

export interface EstablishedContext {
  established: boolean;
  holders: number | null;
  liquidityUsd: number | null;
  /** Why it is or is not established, in one line. */
  basis: string;
}

interface Pair {
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  liquidity?: { usd?: number };
}

/** Pure rule, exported for tests. */
export function judgeEstablished(holders: number | null, liquidityUsd: number | null, disqualified: string[] = []): EstablishedContext {
  if (disqualified.length > 0) {
    return { established: false, holders, liquidityUsd, basis: `not applied: ${disqualified.join(", ")}` };
  }
  if (holders === null || liquidityUsd === null) {
    return {
      established: false,
      holders,
      liquidityUsd,
      basis: `not established: ${holders === null ? "holder count" : "liquidity"} unavailable, strict scoring kept`,
    };
  }
  const ok = holders >= ESTABLISHED_HOLDERS && liquidityUsd >= ESTABLISHED_LIQUIDITY_USD;
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  return {
    established: ok,
    holders,
    liquidityUsd,
    basis: ok
      ? `established: ${fmt(holders)} holders and $${fmt(liquidityUsd)} of Base DEX liquidity (thresholds ${fmt(ESTABLISHED_HOLDERS)} and $${fmt(ESTABLISHED_LIQUIDITY_USD)})`
      : `not established: ${fmt(holders)} holders, $${fmt(liquidityUsd)} Base DEX liquidity (needs ${fmt(ESTABLISHED_HOLDERS)} and $${fmt(ESTABLISHED_LIQUIDITY_USD)})`,
  };
}

/** Sum of liquidity over Base pools where the token is on either side. null when DexScreener did not answer. */
export async function baseLiquidityUsd(address: string): Promise<number | null> {
  const pairs = await dexTokenPairs<Pair>(address);
  if (pairs === null) return null;
  const a = address.toLowerCase();
  return pairs
    .filter((p) => p.baseToken?.address?.toLowerCase() === a || p.quoteToken?.address?.toLowerCase() === a)
    .reduce((t, p) => t + (Number(p.liquidity?.usd) || 0), 0);
}

export async function establishedContext(
  address: string,
  holders: number | null,
  disqualified: string[] = [],
): Promise<EstablishedContext> {
  if (disqualified.length > 0) return judgeEstablished(holders, null, disqualified);
  // Below the holder bar the liquidity read cannot change the answer: skip it.
  if (holders !== null && holders < ESTABLISHED_HOLDERS) {
    return {
      established: false,
      holders,
      liquidityUsd: null,
      basis: `not established: ${holders.toLocaleString("en-US")} holders (needs ${ESTABLISHED_HOLDERS.toLocaleString("en-US")}); liquidity not read`,
    };
  }
  let liq: number | null = null;
  try {
    liq = await baseLiquidityUsd(address);
  } catch {
    liq = null;
  }
  return judgeEstablished(holders, liq);
}
