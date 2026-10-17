/**
 * Base Swap, conditional — a 0x swap wrapped in a Cobalt Validity Transaction.
 *
 * Cobalt (live 2026-10-01) added `base_sendRawTransactionValidity`: submit one
 * signed transaction with a set of predicates, and Base keeps it dormant until
 * every predicate holds, evaluating them against chain state as each block is
 * built. The transaction stays private until it lands. That turns a plain swap
 * into a good-till-block / conditional order WITHOUT a limit-order contract, an
 * approval to a keeper, or anyone else holding the trade.
 *
 * This endpoint builds the ordinary 0x swap (via baseSwap — same sellability
 * check, integrator fee and booking) and attaches the validity predicates. As
 * everywhere else here, WE NEVER HOLD FUNDS OR KEYS: the agent signs the exact
 * transaction we return and submits it, with the validity object, to Base's
 * sequencer. We hand back a ready-to-send JSON-RPC request with a placeholder
 * where the signed transaction goes.
 *
 * What we build natively, because it is exact and pool-agnostic:
 *   - beforeBlock / fromBlock  → a block_number window (a hard deadline: the
 *     trade lands before block N or never — the sequencer drops it otherwise).
 *   - flashblockIndex          → pin inclusion to a flashblock position.
 *   - minNativeBalanceWei      → a balance floor on the taker (native ETH).
 *
 * What we DO NOT fabricate: a "price ≥ X" predicate. A storage predicate reads a
 * RAW storage slot — Base compares `(storage[address][slot] & mask)` to a value
 * and explicitly "does not simulate a transaction and cannot invoke view
 * functions". Mapping a human price onto a pool's slot layout is pool-specific
 * (Uniswap V3 vs V4 vs Aerodrome all differ) and getting it wrong ships a trade
 * that fires at the wrong moment. So a price condition is CALLER-SUPPLIED: an
 * advanced caller who knows their pool's slot passes the raw storage predicate
 * and we validate and forward it, rather than guessing the slot ourselves.
 */

import "server-only";
import { createPublicClient } from "viem";
import { base } from "viem/chains";
import { baseSwap } from "./base-swap";
import { baseTransport } from "./base-transport";

/** The comparison operators Base accepts on a predicate. */
const ALLOWED_OPS = new Set(["<", "<=", "=", "!=", ">", ">="]);

type Op = "<" | "<=" | "=" | "!=" | ">" | ">=";

interface Predicate {
  type: "block_number" | "flashblock_index" | "balance" | "storage";
  params: Record<string, string>;
}

/** Base mainnet sequencer RPC — the endpoint that accepts the validity method. */
const DEFAULT_SEQUENCER = "https://mainnet-sequencer.base.org";

/** The sequencer endpoint a validity transaction is submitted to (env override). */
export function sequencerEndpoint(): string {
  return (process.env.BASE_SEQUENCER_RPC || DEFAULT_SEQUENCER).trim();
}

/**
 * A non-negative integer (block number, flashblock index, wei) as a Base
 * predicate value: a 0x-prefixed, minimal hex QUANTITY. Accepts decimal or hex
 * input. Throws (so the caller is not charged) on anything that is not a
 * non-negative integer.
 */
export function toHexQuantity(raw: string | undefined, label: string): string {
  const s = (raw ?? "").trim();
  if (!s) throw new Error(`${label} is required`);
  let n: bigint;
  try {
    n = BigInt(s); // BigInt handles both "123" and "0x7b"
  } catch {
    throw new Error(`${label} must be a non-negative integer (got "${s}")`);
  }
  if (n < 0n) throw new Error(`${label} must be non-negative`);
  return `0x${n.toString(16)}`;
}

/** A raw 0x hex blob (storage slot / value / mask), validated but not minimised. */
function asHexBlob(raw: string | undefined, label: string): string {
  const s = (raw ?? "").trim();
  if (!/^0x[0-9a-fA-F]+$/.test(s)) throw new Error(`${label} must be a 0x-prefixed hex string`);
  return s.toLowerCase();
}

function asAddress(raw: string | undefined, label: string): string {
  const s = (raw ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error(`${label} must be a 0x… address`);
  return s.toLowerCase();
}

function asOp(raw: string | undefined, label: string): Op {
  const s = (raw ?? "").trim();
  if (!ALLOWED_OPS.has(s)) throw new Error(`${label} must be one of < <= = != > >= (got "${s}")`);
  return s as Op;
}

/**
 * Turn friendly params into a validated, non-empty predicate array.
 *
 * Pure and chain-free so it can be tested exhaustively: every predicate Base
 * supports, every operator, and the refusal when nothing conditional was asked
 * for (a validity array must be non-empty, so an empty one would be a swap with
 * no condition dressed up as one).
 */
export function buildValidityPredicates(params: Record<string, string>): Predicate[] {
  const preds: Predicate[] = [];

  // Deadline / earliest — the common case, and exact on any pool.
  if (params.beforeBlock) preds.push({ type: "block_number", params: { op: "<", value: toHexQuantity(params.beforeBlock, "beforeBlock") } });
  if (params.fromBlock) preds.push({ type: "block_number", params: { op: ">=", value: toHexQuantity(params.fromBlock, "fromBlock") } });

  // Pin to a flashblock position. Base numbers them 1 through 10 (0x1–0xa); an
  // index outside that range can never match.
  if (params.flashblockIndex) {
    const value = toHexQuantity(params.flashblockIndex, "flashblockIndex");
    const n = BigInt(value);
    if (n < 1n || n > 10n) throw new Error(`flashblockIndex must be 1 through 10 (Base numbers flashblocks 1–10; got ${n})`);
    preds.push({
      type: "flashblock_index",
      params: { op: params.flashblockIndexOp ? asOp(params.flashblockIndexOp, "flashblockIndexOp") : "=", value },
    });
  }

  // Native-balance floor on an account (defaults to the taker). Note: this is
  // the NATIVE ETH balance; a token balance or a price lives in a storage slot,
  // which is the advanced predicate below.
  if (params.minNativeBalanceWei) {
    preds.push({
      type: "balance",
      params: { address: asAddress(params.balanceAddress || params.taker, "balanceAddress/taker"), op: ">=", value: toHexQuantity(params.minNativeBalanceWei, "minNativeBalanceWei") },
    });
  }

  // Advanced, caller-supplied storage predicate — the "price ≥ X" path, expressed
  // against a slot the caller knows. All or nothing: address+slot+op+value, with
  // an optional mask. We validate the shape; we do not interpret the slot.
  if (params.storageAddress || params.storageSlot || params.storageValue || params.storageOp || params.storageMask) {
    const p: Record<string, string> = {
      address: asAddress(params.storageAddress, "storageAddress"),
      slot: asHexBlob(params.storageSlot, "storageSlot"),
      op: asOp(params.storageOp, "storageOp"),
      value: asHexBlob(params.storageValue, "storageValue"),
    };
    if (params.storageMask) p.mask = asHexBlob(params.storageMask, "storageMask");
    preds.push({ type: "storage", params: p });
  }

  if (preds.length === 0) {
    throw new Error(
      "A validity transaction needs at least one condition — pass beforeBlock (a deadline), fromBlock, flashblockIndex, minNativeBalanceWei, or a storage predicate (storageAddress+storageSlot+storageOp+storageValue). With none, use the plain base-swap.",
    );
  }
  return preds;
}

/** Base block time, measured 2026-10-17 (1,000 blocks in 2,000 s). */
export const BLOCK_SECONDS = 2;
/**
 * Base's rule (docs.base.org, "Fees, Ordering, and Lifecycle"): every validity
 * transaction MUST carry a block_number upper bound, and the bound must be
 * within 60 seconds of submission. 60 s is 30 blocks; with op "<" the last
 * includable block is beforeBlock - 1, so beforeBlock may be at most current + 31.
 */
export const MAX_DEADLINE_BLOCKS = 31;
/** Used when the caller gives no deadline: ~50 s, leaving room to sign and submit. */
export const DEFAULT_DEADLINE_BLOCKS = 25;

export interface DeadlineResolution {
  /** The beforeBlock that goes into the predicates (the caller's, or one we set). */
  beforeBlock: string | undefined;
  currentBlock: string | null;
  deadlineChecked: boolean;
  /** True when the caller gave none and we set current + DEFAULT_DEADLINE_BLOCKS. */
  deadlineAutoSet: boolean;
  /** Seconds from now until the deadline block, at BLOCK_SECONDS per block. */
  expiresInSeconds: number | null;
}

/**
 * Settle the deadline before any predicate is built.
 *
 * Base refuses a validity transaction without an upper bound, and one whose
 * bound is more than 60 s out. Both endpoints used to accept either — our own
 * example asked for block 999,999,999 — so an agent following us got a request
 * the sequencer would reject. Now:
 *   - no beforeBlock: we set current + 25 and say so;
 *   - a beforeBlock already passed, or more than 60 s ahead: refused as the
 *     caller's input, naming the current block, before anything is charged.
 * If the chain cannot be read and the caller gave a deadline, it is forwarded
 * unchecked and the answer says so; with no deadline we cannot set one, so the
 * call fails as an outage (not charged).
 */
export async function resolveDeadline(params: Record<string, string>): Promise<DeadlineResolution> {
  const given = (params.beforeBlock ?? "").trim();
  if (given) toHexQuantity(given, "beforeBlock"); // malformed input is the caller's, before any chain read
  let current: bigint;
  try {
    current = await createPublicClient({ chain: base, transport: baseTransport(6000, true) }).getBlockNumber();
  } catch {
    if (!given) throw new Error("Base block height unavailable, so no deadline could be set — not charged, retry shortly");
    return { beforeBlock: given, currentBlock: null, deadlineChecked: false, deadlineAutoSet: false, expiresInSeconds: null };
  }
  if (!given) {
    const auto = current + BigInt(DEFAULT_DEADLINE_BLOCKS);
    return {
      beforeBlock: auto.toString(),
      currentBlock: current.toString(),
      deadlineChecked: true,
      deadlineAutoSet: true,
      expiresInSeconds: DEFAULT_DEADLINE_BLOCKS * BLOCK_SECONDS,
    };
  }
  const deadline = BigInt(toHexQuantity(given, "beforeBlock"));
  if (deadline <= current) {
    throw new Error(
      `beforeBlock ${deadline} has already passed: Base is at block ${current}. A deadline must be ahead of the current block (Base makes a block every ${BLOCK_SECONDS} s).`,
    );
  }
  if (deadline - current > BigInt(MAX_DEADLINE_BLOCKS)) {
    throw new Error(
      `beforeBlock ${deadline} is ${deadline - current} blocks (~${Number(deadline - current) * BLOCK_SECONDS} s) ahead of Base block ${current}. Base requires a validity transaction's deadline within 60 s of submission: use at most ${current + BigInt(MAX_DEADLINE_BLOCKS)}, or omit beforeBlock and we set one.`,
    );
  }
  return {
    beforeBlock: given,
    currentBlock: current.toString(),
    deadlineChecked: true,
    deadlineAutoSet: false,
    expiresInSeconds: Number(deadline - current) * BLOCK_SECONDS,
  };
}

export async function baseSwapValidity(params: Record<string, string>) {
  // Settle the deadline and validate the conditions FIRST — a malformed predicate
  // must fail before any 0x call, so a bad condition is never charged.
  const { beforeBlock, ...deadlineCheck } = await resolveDeadline(params);
  const validity = buildValidityPredicates({ ...params, beforeBlock: beforeBlock ?? "" });

  const swap = await baseSwap(params);
  const endpoint = sequencerEndpoint();

  const rpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "base_sendRawTransactionValidity",
    // The agent replaces the placeholder with its own signed, serialized tx.
    params: ["0x<SIGNED_RAW_TRANSACTION>", { validity }],
  };

  const steps = [
    ...(swap.needsApproval
      ? [`Approve once: ${swap.steps.find((s) => /Approve/.test(s)) ?? `approve ${swap.sell.symbol} for the 0x AllowanceHolder`}`]
      : []),
    `Sign the transaction below with ${swap.transaction.from} (EIP-1559 recommended) — but DO NOT broadcast it with eth_sendRawTransaction.`,
    `Instead POST this JSON-RPC request to Base's sequencer (${endpoint}), replacing 0x<SIGNED_RAW_TRANSACTION> with your signed serialized tx. The response is the 32-byte tx hash.`,
    `Base holds it until every condition holds, then includes it. If the deadline block (${beforeBlock}) arrives first, it is never included — no stuck order to cancel.`,
    `Submit within ${deadlineCheck.expiresInSeconds ?? 60} s: Base only accepts a deadline at most 60 s out. If it lapses, call again for a fresh deadline and quote.`,
  ];

  return {
    chain: "base" as const,
    ...deadlineCheck,
    checkedAt: swap.checkedAt,
    router: swap.router,
    conditional: true,
    sell: swap.sell,
    buy: swap.buy,
    route: swap.route,
    fees: swap.fees,
    needsApproval: swap.needsApproval,
    insufficientBalance: swap.insufficientBalance,
    tokenSafety: swap.tokenSafety,
    transaction: swap.transaction,
    validity,
    submit: { method: "base_sendRawTransactionValidity", endpoint, rpcRequest },
    steps,
    priceConditionNote:
      "A 'price ≥ X' condition is a storage predicate on your pool's slot — supplied by you, because a predicate reads a raw slot and cannot call a view function, and slot layouts differ by pool (Uniswap V3/V4, Aerodrome…). We validate and forward it; we do not derive a slot from a price.",
    note: "Conditional swap via Cobalt validity transactions. We never hold funds or keys — you sign and submit. Quotes expire quickly; the signed tx's own gas/slippage still apply when it lands. Not financial advice.",
  };
}
