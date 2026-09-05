/**
 * Coinbase's tokenized equities on Base, and the multiplier they all sit at.
 *
 * WHAT THIS ROSTER IS AND IS NOT
 * ------------------------------
 * It is a SEED, not the source of truth. The truth is the operator anchor in
 * b20-safety.ts: a token is one of these if its TRANSFER_SENDER_POLICY is
 * administered by KNOWN_ASSET_ISSUERS. That check needs no list and recognised
 * all thirteen of these with zero configuration when they were found. The list
 * exists so the watcher below has something to read every morning without
 * re-scanning 54,000 B20Created events to find its own subjects.
 *
 * Discovered from chain on 2026-09-03 from two seed addresses the operator
 * supplied, by filtering B20Created on decimals=8 (88 candidates, versus 54,206
 * at 18) and keeping those whose sender-policy admin matched. Two traps are
 * worth recording because both cost time:
 *
 *   - CDP SQL returns `result: null` with NO error for `parameters['decimals']
 *     = '8'`. It needs `toString(parameters['decimals']) = '8'`.
 *   - B20Created carries the ORIGINAL symbol. GOOGLc's creation event says
 *     "GOOGL"; the metadata role renamed it afterwards. Symbols must be read
 *     from `symbol()` on chain, never from the creation event.
 *
 * WHY A MULTIPLIER WATCH EXISTS AT ALL
 * ------------------------------------
 * On an Asset-variant B20 the multiplier rescales every holder's balance at
 * once. For an equity wrapper that is how a split, a reverse split, or a
 * dividend adjustment arrives — the position does not move, the unit does.
 * Everything downstream that cached a balance is silently wrong the moment it
 * changes, and on 2026-09-03 every top holder of GOOGLc and METAc was a
 * contract (Uniswap V4's PoolManager first among them), so "downstream" here
 * means pools and vaults, not people who would notice.
 *
 * As of 2026-09-04 the count of MultiplierUpdated events across all thirteen is
 * ZERO and every multiplier reads exactly 1.0. That fact shapes what this file
 * is allowed to claim. We can detect that a value changed, because we hold the
 * previous one. We CANNOT yet classify a change as a scheduled ERC-8056 update
 * versus an emergency updateMultiplier(), because no sample of either exists to
 * write that parsing against — so it is deliberately not written. The watcher
 * reports the change and the transaction, and the classification gets built
 * when the first real event supplies something to test it on.
 */

import "server-only";
import { createPublicClient, getAddress } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";

/** WAD — a multiplier of exactly 1.0. Every stock reads this today. */
export const WAD = 10n ** 18n;

/** The policy operator that administers all thirteen. This is the real anchor. */
export const STOCK_POLICY_ADMIN = "0xec0f05c174e54fbf0fe16ad930a8afebce612812";

export interface TokenizedStock {
  /** On-chain symbol, read from symbol() — always the ticker plus a "c". */
  sym: string;
  /** The underlying listed ticker. */
  ticker: string;
  name: string;
  token: `0x${string}`;
}

/** Discovered from chain 2026-09-03; all thirteen share policy id 5. */
export const TOKENIZED_STOCKS: readonly TokenizedStock[] = [
  { sym: "AAPLc", ticker: "AAPL", name: "Apple Inc.", token: "0xb200000000000000000000c2e324d24d7eecd1fb" },
  { sym: "AMZNc", ticker: "AMZN", name: "Amazon.com Inc.", token: "0xb200000000000000000000d9192b6b456483c2e8" },
  { sym: "COINc", ticker: "COIN", name: "Coinbase Global Inc.", token: "0xb200000000000000000000c85a31389d71f3ecfb" },
  { sym: "CRCLc", ticker: "CRCL", name: "Circle Internet Group Inc.", token: "0xb20000000000000000000019f6e7c675b73c2e4d" },
  { sym: "GOOGLc", ticker: "GOOGL", name: "Alphabet Inc.", token: "0xb2000000000000000000002d0ba3164cc74f58b7" },
  { sym: "INTCc", ticker: "INTC", name: "Intel Corporation", token: "0xb2000000000000000000004aff16039ba04bdfbc" },
  { sym: "METAc", ticker: "META", name: "Meta Platforms Inc.", token: "0xb2000000000000000000008bc8786b856e61707c" },
  { sym: "MSFTc", ticker: "MSFT", name: "Microsoft Corporation", token: "0xb200000000000000000000ab99cfa739e253872b" },
  { sym: "MSTRc", ticker: "MSTR", name: "Strategy Inc.", token: "0xb2000000000000000000004884b426556b92883d" },
  { sym: "NVDAc", ticker: "NVDA", name: "NVIDIA Corporation", token: "0xb20000000000000000000078ee7ce2fe4908108c" },
  { sym: "SNDKc", ticker: "SNDK", name: "Sandisk Corporation", token: "0xb200000000000000000000397293cb8cda9a10c5" },
  { sym: "SPCXc", ticker: "SPCX", name: "Space Exploration Technologies Corp.", token: "0xb2000000000000000000007b9fcbd005511acbd5" },
  { sym: "TSLAc", ticker: "TSLA", name: "Tesla Inc.", token: "0xb2000000000000000000001e800a7f5189430cd0" },
] as const;

/** Case-insensitive lookup, so a caller's checksummed address still matches. */
export function tokenizedStockFor(address: string): TokenizedStock | null {
  const a = (address || "").trim().toLowerCase();
  return TOKENIZED_STOCKS.find((s) => s.token === a) ?? null;
}

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

const MULTIPLIER_ABI = [
  { type: "function", name: "multiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export interface MultiplierRead {
  sym: string;
  token: string;
  /** Decimal string, or null when the read failed. NEVER 0 as a stand-in. */
  multiplier: string | null;
}

/**
 * Read multiplier() for every stock, sequentially.
 *
 * Base's public RPC rate-limits parallel eth_calls, and this runs unattended, so
 * one at a time with a small gap. A failed read yields null rather than a
 * number — the caller has to be able to tell "unchanged" from "unknown", or a
 * network blip would be recorded as the new baseline and the real change that
 * follows it would never be reported.
 */
export async function readMultipliers(
  stocks: readonly TokenizedStock[] = TOKENIZED_STOCKS,
): Promise<MultiplierRead[]> {
  const out: MultiplierRead[] = [];
  for (const s of stocks) {
    let value: string | null = null;
    try {
      const m = (await client.readContract({
        address: getAddress(s.token),
        abi: MULTIPLIER_ABI,
        functionName: "multiplier",
      })) as bigint;
      value = m.toString();
    } catch {
      value = null;
    }
    out.push({ sym: s.sym, token: s.token, multiplier: value });
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

const BOARD_ABI = [
  { type: "function", name: "multiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isPaused", stateMutability: "view", inputs: [{ type: "uint8" }], outputs: [{ type: "bool" }] },
] as const;

/** Tokenized equities carry 8 decimals, not the 18 an ERC-20 reader would assume. */
const SHARE_UNIT = 10n ** 8n;

export interface StockBoardRow {
  sym: string;
  ticker: string;
  name: string;
  token: string;
  /** null when the read failed — never 0, which would read as "no supply". */
  supplyShares: number | null;
  multiplier: string | null;
  multiplierRatio: number | null;
  transferPaused: boolean | null;
  /**
   * Deployed but never issued. All thirteen contracts were created within five
   * minutes of each other on 2026-07-26; supply arrives in batches, so a zero
   * here means "announced, not yet launched" rather than "not real".
   */
  issued: boolean | null;
}

/**
 * Read the whole board, sequentially.
 *
 * Base's public RPC rate-limits parallel eth_calls and this is a public page, so
 * one read at a time with a small gap. A failure yields null rather than a
 * number: on a board whose entire point is "the number you are reading is not
 * the number you think", silently substituting a zero would be the worst
 * available bug.
 */
export async function readStockBoard(): Promise<{
  asOf: string;
  count: number;
  issuedCount: number;
  rows: StockBoardRow[];
  degraded: boolean;
  finding: string;
  note: string;
}> {
  const rows: StockBoardRow[] = [];
  for (const s of TOKENIZED_STOCKS) {
    const addr = getAddress(s.token);
    const read = async <T>(fn: "multiplier" | "totalSupply" | "isPaused", args?: readonly [number]) => {
      try {
        return (await client.readContract({ address: addr, abi: BOARD_ABI, functionName: fn, ...(args ? { args } : {}) })) as T;
      } catch {
        return null;
      }
    };
    const mult = await read<bigint>("multiplier");
    await new Promise((r) => setTimeout(r, 90));
    const supply = await read<bigint>("totalSupply");
    await new Promise((r) => setTimeout(r, 90));
    const paused = await read<boolean>("isPaused", [0]);
    await new Promise((r) => setTimeout(r, 90));

    rows.push({
      sym: s.sym,
      ticker: s.ticker,
      name: s.name,
      token: s.token,
      supplyShares: supply === null ? null : Number((supply * 1000n) / SHARE_UNIT) / 1000,
      multiplier: mult === null ? null : mult.toString(),
      multiplierRatio: mult === null ? null : Number((mult * 1_000_000n) / WAD) / 1_000_000,
      transferPaused: paused,
      issued: supply === null ? null : supply > 0n,
    });
  }

  const degraded = rows.some((r) => r.multiplier === null || r.supplyShares === null);
  const moved = rows.filter((r) => r.multiplierRatio !== null && r.multiplierRatio !== 1);
  const issuedCount = rows.filter((r) => r.issued === true).length;

  return {
    asOf: new Date().toISOString(),
    count: rows.length,
    issuedCount,
    rows,
    degraded,
    finding:
      moved.length > 0
        ? `${moved.length} of ${rows.length} carry a multiplier other than 1.0 — for those, balanceOf understates or overstates the real position by exactly that factor.`
        : "Every multiplier reads 1.0, so no corporate action has been applied to any of these yet. The day one is, balanceOf will not move and every naive reader will be silently wrong.",
    note:
      "B20 Asset tokens do not apply multiplier() to balanceOf() — measured on chain: a multiplier moved 1.0 to 2.0 and holder balances read identically before and after. This board is free; per-wallet answers are the paid stock-position endpoint. Not financial advice.",
  };
}

/**
 * Describe a multiplier move the way a holder experiences it.
 *
 * A multiplier is not a price. Going from 1.0 to 4.0 does not mean the position
 * gained 300% — it means the same value is now denominated in four times as
 * many units, which is what a 4-for-1 split looks like on chain. The wording
 * here says that explicitly, because the failure mode of a terse alert is an
 * operator reading a split as a windfall.
 */
export function describeMultiplierChange(from: bigint, to: bigint): string {
  if (to === from) return "unchanged";
  const ratio = Number((to * 10000n) / (from === 0n ? WAD : from)) / 10000;
  const direction = to > from ? "up" : "down";
  const unitEffect =
    to > from
      ? `every holder's unit count is multiplied by ${ratio}× (a split-shaped move: more units, not more value)`
      : `every holder's unit count is multiplied by ${ratio}× (a reverse-split-shaped move: fewer units, not less value)`;
  return `${direction} ${ratio}× — ${unitEffect}`;
}
