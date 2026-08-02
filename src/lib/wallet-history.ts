/**
 * When a wallet first appeared on Base — read straight from the archive node.
 *
 * `wallet-summary` and `first-funder` both need one fact no 30-day feed can give:
 * the earliest block an address ever touched. That used to come from Covalent's
 * `transactions_summary`, and when the GoldRush plan was cancelled both services
 * went dark. The two obvious replacements are closed too: Etherscan's free tier
 * dropped Base entirely ("Free API access is not supported for this chain"), and
 * the CDP SQL API refuses any address-filtered scan wider than ~90 days — 180
 * days already trips its 93 GiB per-query read cap.
 *
 * What we do still have is CDP Node, and it turns out to be a full archive: it
 * answers `eth_getTransactionCount` and `eth_getBalance` at any historical block,
 * back to block 1. That is enough to *search* for the first block instead of
 * asking for it. Nonce is monotonic — once an account sends, it has sent forever
 * — so "nonce >= 1" is a clean predicate to bisect on, and balance gives a second
 * one that also catches wallets that were funded but never spent.
 *
 * The search is widened rather than binary: each round probes FAN points at once
 * through a batching transport, so it divides the range by FAN+1 per round-trip
 * instead of by 2. Across Base's ~49M blocks that is ~9 rounds / ~60 reads /
 * under two seconds, versus 26 serial round-trips for a plain bisect.
 *
 * Balance is NOT monotonic — a wallet can be drained to zero and refunded later —
 * so a bisect on it can land on a *later* funding and miss the real first one.
 * Every candidate is therefore verified against its predecessor block: if the
 * account was already non-empty at B-1, the search restarts below B. That loop is
 * what makes the answer trustworthy rather than merely plausible.
 */

import "server-only";
import { createPublicClient, fallback, http, getAddress, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { getConfig } from "./config";

/** Probes per round. Each round is one HTTP request thanks to the batching
 *  transport, so this trades request size for round-trips. 7 lands the whole
 *  search inside ~9 requests without building batches the node will reject. */
const FAN = 7;
/** Base's first block. Nothing can predate it, so the search never looks lower. */
const GENESIS = 1n;
/** Hard stop on the verify-and-restart loop. Each pass strictly lowers the upper
 *  bound, so this can only be reached by a node giving inconsistent state; we
 *  degrade to "unverified" rather than spin. */
const MAX_PASSES = 4;

/**
 * A client whose concurrent reads collapse into a single JSON-RPC batch.
 * `wait: 0` means "batch whatever is already queued in this tick" — the search
 * fires all FAN probes synchronously, so they land in one request without any
 * added latency. Same CDP-then-public fallback as the shared transport.
 */
function searchClient(timeoutMs: number): PublicClient {
  const configured = getConfig().rpcUrl;
  const opts = { timeout: timeoutMs, batch: { wait: 0 } } as const;
  const transport = configured
    ? fallback([http(configured, opts), http(undefined, opts)], { rank: false })
    : http(undefined, opts);
  return createPublicClient({ chain: base, transport }) as PublicClient;
}

/** True once the account exists in state at this block. */
interface Probe {
  (block: bigint): Promise<boolean>;
}

/**
 * Lowest block in [lo, hi] where `probe` holds, assuming it holds monotonically.
 * Returns hi if it never does. The caller is responsible for verifying the
 * monotonicity assumption actually held — see `firstAppearance`.
 */
export async function firstBlockWhere(lo: bigint, hi: bigint, probe: Probe): Promise<bigint> {
  while (lo < hi) {
    const span = hi - lo;
    if (span <= BigInt(FAN)) {
      // Few enough left to settle exactly in one batch.
      const points: bigint[] = [];
      for (let b = lo; b <= hi; b++) points.push(b);
      const hits = await Promise.all(points.map(probe));
      const i = hits.indexOf(true);
      return i === -1 ? hi : points[i];
    }
    const points: bigint[] = [];
    for (let i = 1n; i <= BigInt(FAN); i++) points.push(lo + (span * i) / BigInt(FAN + 1));
    const hits = await Promise.all(points.map(probe));
    const i = hits.indexOf(true);
    if (i === -1) {
      // Every probe is still empty: the answer sits above the highest one.
      lo = points[points.length - 1] + 1n;
    } else {
      // First hit brackets it: above the previous probe, at or below this one.
      hi = points[i];
      lo = i === 0 ? lo : points[i - 1] + 1n;
    }
  }
  return lo;
}

export interface FirstAppearance {
  /** Block the account first existed in state. */
  block: bigint;
  /** ISO timestamp of that block. */
  at: string;
  /** The account was provably empty at block-1 (no balance, no nonce). When
   *  false the node contradicted itself and the block is a best effort. */
  verified: boolean;
  /** Outgoing transactions ever sent (the account nonce). Not a total tx count —
   *  transfers *in* and token-only activity do not raise it. */
  outgoingTxCount: number;
  /** The transaction in that block that involved the wallet, when one is visible
   *  at the top level. Internal transfers and token mints leave none. */
  tx: { hash: string; from: string; to: string | null; valueWei: bigint } | null;
}

/** Has this account done anything at all by `block`? */
async function existsAt(client: PublicClient, address: Address, block: bigint): Promise<boolean> {
  const [nonce, balance] = await Promise.all([
    client.getTransactionCount({ address, blockNumber: block }),
    client.getBalance({ address, blockNumber: block }),
  ]);
  return nonce > 0 || balance > 0n;
}

/**
 * Find the earliest block where `address` existed on Base, or null if the
 * archive shows nothing at all for it (never funded in ETH, never sent).
 *
 * Null is NOT the same as "this wallet has no history": an address that only
 * ever held tokens, and only through internal transfers, is invisible to both
 * probes. Callers must say "could not resolve", never "no activity".
 */
export async function firstAppearance(
  addressIn: string,
  opts: { withTx?: boolean; client?: PublicClient; head?: bigint; timeoutMs?: number } = {},
): Promise<FirstAppearance | null> {
  const address = getAddress(addressIn) as Address;
  const client = opts.client ?? searchClient(opts.timeoutMs ?? 12_000);
  const head = opts.head ?? (await client.getBlockNumber());

  const [nonceNow, balanceNow] = await Promise.all([
    client.getTransactionCount({ address, blockNumber: head }),
    client.getBalance({ address, blockNumber: head }),
  ]);
  if (nonceNow === 0 && balanceNow === 0n) return null; // nothing to bisect on

  let hi = head;
  let block = head;
  let verified = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    block = await firstBlockWhere(GENESIS, hi, (b) => existsAt(client, address, b));
    if (block <= GENESIS) {
      verified = true;
      break;
    }
    // Monotonicity check: a genuine first appearance has an empty predecessor.
    if (!(await existsAt(client, address, block - 1n))) {
      verified = true;
      break;
    }
    // The account was already alive earlier — balance must have dipped to zero in
    // between. Search strictly below this candidate.
    hi = block - 1n;
  }

  // A Base block carries a few hundred transactions, so pulling the full body is
  // by far the heaviest call in this path. Only `first-funder` needs it — asking
  // for the wallet's age does not — so the header-only read is the default.
  const blk = opts.withTx
    ? await client.getBlock({ blockNumber: block, includeTransactions: true })
    : await client.getBlock({ blockNumber: block });
  const lower = address.toLowerCase();
  const hit = opts.withTx
    ? blk.transactions.find((t) => typeof t !== "string" && (t.to?.toLowerCase() === lower || t.from.toLowerCase() === lower))
    : undefined;

  return {
    block,
    at: new Date(Number(blk.timestamp) * 1000).toISOString(),
    verified,
    outgoingTxCount: nonceNow,
    tx:
      hit && typeof hit !== "string"
        ? { hash: hit.hash, from: getAddress(hit.from), to: hit.to ? getAddress(hit.to) : null, valueWei: hit.value }
        : null,
  };
}

/**
 * Block of the wallet's most recent OUTGOING transaction, found the same way.
 * The predicate is "nonce has already reached its final value", which is
 * monotonic for the same reason the first-appearance one is, so no verify pass
 * is needed here. Returns null for an address that has never sent anything —
 * its last *inbound* activity is not visible to this search.
 */
async function lastOutgoingBlock(client: PublicClient, address: Address, head: bigint, nonceNow: number): Promise<bigint | null> {
  if (nonceNow === 0) return null;
  return firstBlockWhere(GENESIS, head, async (b) => (await client.getTransactionCount({ address, blockNumber: b })) >= nonceNow);
}

/**
 * Wallet age & activity — the shape `wallet-summary` sells and `ai-wallet-report`
 * folds into its prompt.
 *
 * Deliberately narrower than the Covalent version it replaces, and the field
 * names say so: the archive can count what an account *sent* (its nonce) but not
 * what it received, so `outgoingTxCount` is not the old `txCount` under a new
 * label. Anything this cannot establish comes back null with a `coverage` note
 * rather than a zero — a wallet reported as "0 transactions" when it merely
 * receives tokens would be a wrong sybil verdict, which is exactly the call this
 * endpoint exists to inform.
 */
export async function walletSummary(params: Record<string, string>) {
  const raw = (params.address || params.wallet || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… wallet address (address=)");
  const address = getAddress(raw) as Address;
  const client = searchClient(12_000);

  const head = await client.getBlockNumber();
  const nonceNow = await client.getTransactionCount({ address, blockNumber: head });

  // Both searches share the batching client and the head we already read, so
  // their probes ride the same round-trips instead of doubling the wall time.
  const [first, lastBlock] = await Promise.all([
    firstAppearance(address, { client, head }),
    lastOutgoingBlock(client, address, head, nonceNow),
  ]);

  if (!first) {
    return {
      address,
      outgoingTxCount: 0,
      firstActivity: null,
      lastActivity: null,
      ageDays: null,
      activity: "unresolved",
      coverage:
        "This address holds no ETH and has never sent a transaction, so the archive search finds nothing to date. " +
        "It may still have token-only history received via internal transfers — treat this as 'could not establish', not 'no activity'.",
      source: "base-archive",
      checkedAt: new Date().toISOString(),
    };
  }

  const lastAt = lastBlock ? new Date(Number((await client.getBlock({ blockNumber: lastBlock })).timestamp) * 1000).toISOString() : null;
  const ageDays = Math.floor((Date.now() - new Date(first.at).getTime()) / 86400000);

  return {
    address,
    outgoingTxCount: nonceNow,
    firstActivity: first.at,
    firstBlock: Number(first.block),
    lastActivity: lastAt,
    ageDays,
    activity: nonceNow === 0 ? "receive_only" : nonceNow < 10 ? "low" : nonceNow < 1000 ? "active" : "very_active",
    firstActivityVerified: first.verified,
    coverage:
      "First activity is the earliest block at which this account existed in state (balance or nonce), verified against " +
      "its predecessor block. Counts and last-activity cover transactions the wallet SENT; inbound transfers and token " +
      "movements do not raise the nonce and are not counted here.",
    source: "base-archive",
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Earliest transaction an address appears in — the provenance seed `first-funder`
 * traces. Same archive search; the caller resolves who the counterparty was.
 */
export async function walletFirstTx(
  address: string,
): Promise<{ txHash: string | null; firstAt: string | null; txCount: number; verified: boolean; resolved: boolean }> {
  const first = await firstAppearance(address, { withTx: true });
  if (!first) return { txHash: null, firstAt: null, txCount: 0, verified: false, resolved: false };
  return {
    txHash: first.tx?.hash ?? null,
    firstAt: first.at,
    txCount: first.outgoingTxCount,
    verified: first.verified,
    resolved: true,
  };
}
