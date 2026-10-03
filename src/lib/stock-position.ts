/**
 * How many shares does this wallet actually control?
 *
 * THE FACT THIS ENDPOINT EXISTS FOR
 * ---------------------------------
 * On a B20 Asset token, `multiplier()` is NOT applied to `balanceOf()`. This was
 * measured, not assumed: on token 0xb2000000000000000000000971c4062c121ca876 the
 * multiplier went 1.0 → 2.0 at block 50819308, and a holder's `balanceOf` read
 * 100000000 at block 50819307 and 100000000 at block 50819309. The entitlement
 * doubled; the number every wallet, explorer and integrator displays did not
 * move. `totalSupply()` behaves the same way — it equals the raw minted sum
 * regardless of the multiplier.
 *
 * That is the whole problem. Coinbase's tokenized equities settle corporate
 * actions by moving this multiplier — a split, a reverse split, a dividend
 * adjustment — so anyone treating `balanceOf` as a share count is wrong by
 * exactly the multiplier the moment one fires. A portfolio app shows the old
 * number. A vault computing NAV as balance × price is wrong by the same factor.
 * An accountant reconstructing cost basis has no idea which multiplier applied
 * at which block.
 *
 * As of 2026-09-05 every one of the thirteen reads exactly 1.0, so today this
 * endpoint returns the same number a naive read would. That is not a reason to
 * skip it — it is the reason to have it in place BEFORE the first one moves,
 * because the day it moves is the day every naive reader is silently wrong and
 * nobody gets a warning.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It counts the wallet's own balance. It does NOT decompose LP or lending
 * positions, and it says so in every response rather than letting a caller read
 * a total as complete. That refusal is the point: a position API that silently
 * omits a venue is worse than none, because the omission looks like a zero.
 *
 * Aerodrome was the obvious first venue to add and the measurement said
 * otherwise — on 2026-09-05 no Aerodrome contract appeared among the largest
 * holders of NVDAc, GOOGLc or AAPLc. The liquidity that exists is in Uniswap
 * V4's singleton PoolManager (2,464 NVDAc, 372 GOOGLc, 366 AAPLc), whose
 * positions are held as PositionManager NFTs and need real work to decompose.
 * Writing an Aerodrome decoder first would have been building for an empty
 * venue.
 */

import "server-only";
import { createPublicClient, getAddress } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import {
  TOKENIZED_STOCKS,
  WAD,
  readSchedules,
  describeScheduledMultiplier,
  type TokenizedStock,
  type ScheduledMultiplier,
} from "./tokenized-stocks";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

const ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "multiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

// Batched reads — the roster is 80+ tokens, so a per-token sequential loop would
// make this paid call take most of a minute. allowFailure keeps the "null on
// failure, never 0" rule the entitlement math depends on.
type MCR = { status: "success"; result: unknown } | { status: "failure"; error: Error };
async function mc(contracts: readonly unknown[], chunk = 50): Promise<MCR[]> {
  const out: MCR[] = [];
  for (let i = 0; i < contracts.length; i += chunk) {
    const slice = contracts.slice(i, i + chunk);
    try {
      out.push(...((await client.multicall({ contracts: slice as never, allowFailure: true })) as unknown as MCR[]));
    } catch {
      for (let k = 0; k < slice.length; k++) out.push({ status: "failure", error: new Error("multicall chunk unavailable") });
    }
  }
  return out;
}
const mcv = <T>(r: MCR | undefined): T | null => (r && r.status === "success" ? (r.result as T) : null);

/** Every tokenized equity carries 8 decimals. Read, not assumed — the 18-decimal
 *  default would misreport every balance by ten orders of magnitude. */
const SHARE_DECIMALS = 8;
const SHARE_UNIT = 10n ** BigInt(SHARE_DECIMALS);

/** Fixed-point → number, without the precision loss of BigInt→Number on the raw value. */
export function toShares(raw: bigint): number {
  return Number((raw * 1_000_000n) / SHARE_UNIT) / 1_000_000;
}

/**
 * The entitlement: raw balance scaled by the multiplier.
 *
 * Integer-only, and the division is last. Converting either operand to a Number
 * first would round a 2,976.885-share position at the eighth decimal and then
 * multiply the error by the multiplier — the arithmetic has to survive a
 * 4-for-1 split without inventing or losing a fraction of a share.
 */
export function entitledRawFrom(raw: bigint, multiplier: bigint): bigint {
  return (raw * multiplier) / WAD;
}

export interface StockPosition {
  symbol: string;
  ticker: string;
  token: string;
  /** Exactly what balanceOf returns. The number every naive integrator uses. */
  rawBalance: string;
  /** rawBalance in share units — still NOT the entitlement. */
  reportedShares: number;
  multiplier: string;
  multiplierRatio: number;
  /** rawBalance × multiplier. The number that is actually owed. */
  entitledShares: number;
  /** True when the two differ, i.e. a corporate action has been applied. */
  adjusted: boolean;
  /**
   * A pending ERC-8056 multiplier change on THIS holding (Cobalt), read before it
   * takes effect — a split/accrual queued for a future block that will rescale
   * entitledShares when it lands. Present only when one is actually scheduled.
   */
  scheduledChange?: { pending: string; effectiveAt: number | null; effectiveAtIso: string | null; pendingRatio: number | null; summary: string | null };
}

export async function stockPosition(params: Record<string, string>) {
  const wallet = (params.wallet || params.address || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new Error("Provide a wallet address (wallet=)");
  const w = getAddress(wallet);

  const positions: StockPosition[] = [];
  const unreadable: string[] = [];

  // One multicall for balanceOf(wallet)+multiplier across the whole roster.
  const stocks = TOKENIZED_STOCKS as readonly TokenizedStock[];
  const contracts: unknown[] = [];
  for (const s of stocks) {
    const address = getAddress(s.token);
    contracts.push({ address, abi: ABI, functionName: "balanceOf", args: [w] });
    contracts.push({ address, abi: ABI, functionName: "multiplier" });
  }
  const res = await mc(contracts);

  // Decide held vs unreadable. A read that FAILED is not a zero balance
  // (unknown ≠ "holds nothing"); a held token whose multiplier is unknown is
  // unreadable, never silently 1.0 — the two most damaging wrong answers here.
  const held: Array<{ s: TokenizedStock; raw: bigint; mult: bigint }> = [];
  stocks.forEach((s, i) => {
    const raw = mcv<bigint>(res[i * 2]);
    if (raw === null) { unreadable.push(s.sym); return; }
    if (raw === 0n) return; // not held
    const mult = mcv<bigint>(res[i * 2 + 1]);
    if (mult === null || mult === 0n) { unreadable.push(s.sym); return; }
    held.push({ s, raw, mult });
  });

  // Cobalt: a pending change on each held token, read before it rescales the
  // entitlement — batched, and only for what is held.
  const curBySym = new Map<string, bigint | null>(held.map((h) => [h.s.sym, h.mult]));
  const schedules = held.length ? await readSchedules(held.map((h) => h.s), curBySym) : new Map<string, ScheduledMultiplier>();

  for (const { s, raw, mult } of held) {
    const scheduled: ScheduledMultiplier = schedules.get(s.sym) ?? { pending: null, effectiveAt: null, status: "none" };
    const entitledRaw = entitledRawFrom(raw, mult);
    positions.push({
      symbol: s.sym,
      ticker: s.ticker,
      token: s.token,
      rawBalance: raw.toString(),
      reportedShares: toShares(raw),
      multiplier: mult.toString(),
      multiplierRatio: Number((mult * 1_000_000n) / WAD) / 1_000_000,
      entitledShares: toShares(entitledRaw),
      adjusted: mult !== WAD,
      ...(scheduled.status === "scheduled"
        ? {
            scheduledChange: {
              pending: scheduled.pending as string,
              effectiveAt: scheduled.effectiveAt,
              effectiveAtIso: scheduled.effectiveAt ? new Date(scheduled.effectiveAt * 1000).toISOString() : null,
              pendingRatio: scheduled.pending ? Number((BigInt(scheduled.pending) * 1_000_000n) / WAD) / 1_000_000 : null,
              summary: describeScheduledMultiplier(mult.toString(), scheduled),
            },
          }
        : {}),
    });
  }

  const adjusted = positions.filter((p) => p.adjusted);
  const queued = positions.filter((p) => p.scheduledChange);
  const degraded = unreadable.length > 0;

  return {
    wallet: w,
    scanned: TOKENIZED_STOCKS.length,
    held: positions.length,
    positions: positions.sort((a, b) => b.entitledShares - a.entitledShares),
    // Any non-empty list means every total below is a FLOOR. Named so it cannot
    // be read as an inventory.
    ...(degraded ? { degraded: true, unreadable } : { degraded: false }),
    adjustedCount: adjusted.length,
    ...(queued.length
      ? {
          scheduledCount: queued.length,
          scheduledChanges: queued.map((p) => ({ symbol: p.symbol, ...p.scheduledChange })),
        }
      : {}),
    /**
     * What a caller must not assume is included. This is published on every
     * response, not only when something is missing, because a total that looks
     * complete is exactly how a position API causes the loss it exists to
     * prevent.
     */
    coverage: {
      walletBalance: true,
      uniswapV4Lp: false,
      aerodromeLp: false,
      aaveCollateral: false,
      morphoCollateral: false,
      eulerCollateral: false,
      vaultShares: false,
      note:
        "Wallet-held balances only. If this wallet has supplied these tokens to a pool, a vault or a lending market, that exposure is NOT in the figures above and the totals are a floor, not a position.",
    },
    finding:
      (adjusted.length > 0
        ? `${adjusted.length} of ${positions.length} holding(s) carry a multiplier other than 1.0, so balanceOf under- or over-states the entitlement. Use entitledShares.`
        : "Every multiplier reads 1.0, so reportedShares and entitledShares agree today. They stop agreeing the moment a corporate action fires, and balanceOf will not move when it does.") +
      (queued.length
        ? ` ${queued.length} holding(s) have a corporate action SCHEDULED (Cobalt ERC-8056): ${queued.map((p) => `${p.symbol} ${p.scheduledChange?.summary ?? "pending"}`).join("; ")} — read before it lands, so entitledShares will move then.`
        : ""),
    note:
      "B20 Asset tokens do NOT apply multiplier() to balanceOf() — measured on chain: a multiplier moved 1.0 → 2.0 and holder balances read identically before and after. Coinbase settles splits and dividend adjustments on tokenized equities through that multiplier, so entitledShares is the share count and rawBalance is what an unadjusted integrator would show. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
