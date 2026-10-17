/**
 * Liquidity guard — turns a pre-trade verdict into a condition Base enforces.
 *
 * pre-trade-gate reads the chain at time T; the agent's trade lands at T+n. If
 * the pool is drained in between (the rug the gate exists to catch), the GO was
 * true when given and wrong when used, and nothing could stop the trade.
 *
 * Cobalt validity transactions close that gap. A `storage` predicate is checked
 * by Base against the state immediately before the transaction would execute;
 * if it is false the transaction is not included at all — no revert, no gas.
 * So alongside the verdict we hand back the predicate "the deepest pool still
 * holds at least X of its counter token (WETH, USDC…)". A pool that is pulled
 * fails it, and the trade never happens.
 *
 * A predicate reads a RAW storage slot (it cannot call balanceOf), and Base's own
 * guidance is to verify the layout before relying on one. So the slot is never
 * assumed: we compute candidate slots for the counter token's balance mapping
 * (Solidity mapping at slots 0–20, Vyper's reversed hashing, OpenZeppelin 5's
 * namespaced ERC-20 storage) and keep one only when the stored word equals
 * balanceOf(pool) exactly, read at the same block. No exact match, no predicate:
 * we say so rather than guess.
 */

import "server-only";
import { createPublicClient, encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { dexTokenPairs } from "./upstream-cache";
import { kvGet, kvSet } from "./kv";
import { deepestPool, type DexPoolLike } from "./dex-pool";
import { BLOCK_SECONDS, DEFAULT_DEADLINE_BLOCKS, sequencerEndpoint } from "./base-swap-validity";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

/** OpenZeppelin Contracts 5 ERC20Storage location (ERC-7201); `_balances` is its first member. */
const OZ5_ERC20_STORAGE = BigInt("0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00");

export type SlotLayout = { kind: "solidity" | "vyper" | "oz5"; slot: string };

/** Storage key of `holder` in a balances mapping laid out as `layout`. Pure; exported for tests. */
export function balanceSlotKey(holder: string, layout: SlotLayout): Hex {
  const s = BigInt(layout.slot);
  return layout.kind === "vyper"
    ? keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [s, holder as Address]))
    : keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder as Address, s]));
}

export function candidateLayouts(): SlotLayout[] {
  const out: SlotLayout[] = [];
  for (let i = 0; i <= 20; i++) out.push({ kind: "solidity", slot: `0x${i.toString(16)}` });
  for (let i = 0; i <= 10; i++) out.push({ kind: "vyper", slot: `0x${i.toString(16)}` });
  out.push({ kind: "oz5", slot: `0x${OZ5_ERC20_STORAGE.toString(16)}` });
  return out;
}

const client = () => createPublicClient({ chain: base, transport: baseTransport(6000, true) });

/**
 * The balances-mapping layout of `token`, proven against `holder`'s balance at
 * one block. Cached per token: a token's layout does not change (a proxy upgrade
 * could move it, which is why a cached layout is re-proven on every use).
 */
export async function findBalanceLayout(token: string, holder: string): Promise<{ layout: SlotLayout; balance: bigint; key: Hex; block: bigint } | null> {
  const c = client();
  const block = await c.getBlockNumber();
  const balance = await c.readContract({ address: token as Address, abi: erc20, functionName: "balanceOf", args: [holder as Address], blockNumber: block });
  // A zero balance matches every empty slot: nothing is proven by it.
  if (balance === 0n) return null;
  const read = async (layout: SlotLayout) => {
    const key = balanceSlotKey(holder, layout);
    const v = await c.getStorageAt({ address: token as Address, slot: key, blockNumber: block }).catch(() => undefined);
    return v !== undefined && v !== null && BigInt(v) === balance ? { layout, balance, key, block } : null;
  };
  const cacheKey = `liqguard:layout:${token.toLowerCase()}`;
  const cached = await kvGet(cacheKey).catch(() => null);
  if (cached) {
    try {
      const hit = await read(JSON.parse(cached) as SlotLayout);
      if (hit) return hit;
    } catch {
      /* fall through to a full probe */
    }
  }
  const results = await Promise.all(candidateLayouts().map(read));
  const hit = results.find((r) => r !== null) ?? null;
  if (hit) await kvSet(cacheKey, JSON.stringify(hit.layout), 30 * 86400).catch(() => {});
  return hit;
}

export interface LiquidityGuard {
  available: true;
  /** What Base will check, in words. */
  condition: string;
  pool: { address: string; dex: string | null; liquidityUsd: number };
  guardedToken: { address: string; symbol: string | null; decimals: number };
  currentBalance: string;
  floorBalance: string;
  maxDropPct: number;
  slot: { layout: SlotLayout["kind"]; mappingSlot: string; key: string; verifiedAtBlock: string };
  /** Ready for base_sendRawTransactionValidity: the deadline Base requires + the guard. */
  validity: Array<{ type: string; params: Record<string, string> }>;
  currentBlock: string;
  expiresInSeconds: number;
  submit: { method: "base_sendRawTransactionValidity"; endpoint: string; rpcRequest: unknown };
  steps: string[];
}

export type GuardResult = LiquidityGuard | { available: false; reason: string };

interface Pair extends DexPoolLike {
  pairAddress?: string;
}

/** Format base units with `decimals`, trimmed. */
function units(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac.slice(0, 8)}` : int;
}

/**
 * Build the guard for a trade into `token`. `maxDropPct` is how far the pool's
 * counter-token balance may fall before the trade is no longer wanted.
 * Never throws: a guard that cannot be built is reported with the reason.
 */
export async function buildLiquidityGuard(token: string, maxDropPct = 20): Promise<GuardResult> {
  try {
    const pairs = await dexTokenPairs<Pair>(token);
    if (pairs === null) return { available: false, reason: "DEX data unavailable this call" };
    // A pool with a 20-byte address holds its own tokens. Uniswap v4 pools live
    // inside the PoolManager singleton (32-byte ids), so their balances cannot be
    // read per pool.
    const own = pairs.filter((p) => /^0x[0-9a-fA-F]{40}$/.test(p.pairAddress ?? ""));
    const deep = deepestPool(own, token);
    if (!deep) return { available: false, reason: "no pool with its own token balance (only Uniswap v4 / none)" };
    const pool = deep.pair.pairAddress as string;
    const counter = (deep.side === "base" ? deep.pair.quoteToken : deep.pair.baseToken)?.address;
    if (!counter || !/^0x[0-9a-fA-F]{40}$/.test(counter)) return { available: false, reason: "pool counter token unreadable" };

    const found = await findBalanceLayout(counter, pool);
    if (!found) return { available: false, reason: "the counter token's balance slot could not be proven (non-standard storage); no predicate rather than a guessed one" };

    const c = client();
    const [decimals, symbol] = await Promise.all([
      c.readContract({ address: counter as Address, abi: erc20, functionName: "decimals" }).catch(() => 18),
      c.readContract({ address: counter as Address, abi: erc20, functionName: "symbol" }).catch(() => null),
    ]);
    const drop = Math.min(Math.max(Math.round(maxDropPct), 1), 90);
    const floor = (found.balance * BigInt(100 - drop)) / 100n;
    const deadline = found.block + BigInt(DEFAULT_DEADLINE_BLOCKS);
    const validity: Array<{ type: string; params: Record<string, string> }> = [
      { type: "block_number", params: { op: "<", value: `0x${deadline.toString(16)}` } },
      { type: "storage", params: { address: counter.toLowerCase(), slot: found.key, op: ">=", value: `0x${floor.toString(16)}` } },
    ];
    const endpoint = sequencerEndpoint();
    const sym = typeof symbol === "string" ? symbol : null;
    return {
      available: true,
      condition: `Include only while pool ${pool} still holds ≥ ${units(floor, Number(decimals))} ${sym ?? "counter token"} (now ${units(found.balance, Number(decimals))}; a drop of more than ${drop}% — a pulled pool — and the trade is never included), before block ${deadline}.`,
      pool: { address: pool, dex: deep.pair.dexId ?? null, liquidityUsd: Math.round(deep.liquidityUsd) },
      guardedToken: { address: counter, symbol: sym, decimals: Number(decimals) },
      currentBalance: found.balance.toString(),
      floorBalance: floor.toString(),
      maxDropPct: drop,
      slot: { layout: found.layout.kind, mappingSlot: found.layout.slot, key: found.key, verifiedAtBlock: found.block.toString() },
      validity,
      currentBlock: found.block.toString(),
      expiresInSeconds: DEFAULT_DEADLINE_BLOCKS * BLOCK_SECONDS,
      submit: {
        method: "base_sendRawTransactionValidity",
        endpoint,
        rpcRequest: { jsonrpc: "2.0", id: 1, method: "base_sendRawTransactionValidity", params: ["0x<SIGNED_RAW_TRANSACTION>", { validity }] },
      },
      steps: [
        "Sign your swap (EIP-1559 recommended) and do NOT broadcast it with eth_sendRawTransaction.",
        `POST the rpcRequest to ${endpoint} with your signed tx in place of the placeholder, within ${DEFAULT_DEADLINE_BLOCKS * BLOCK_SECONDS} s (Base requires the deadline within 60 s).`,
        "If the pool is drained before your trade lands, Base never includes it: no revert, no gas. Too late? Call again for a fresh deadline and sign again — Base ignores a resubmitted identical signed tx after expiry (measured 2026-10-17); change any fee field.",
      ],
    };
  } catch (err) {
    return { available: false, reason: `guard could not be built: ${err instanceof Error ? err.message.slice(0, 120) : "error"}` };
  }
}
