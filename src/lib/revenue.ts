/**
 * Revenue reader — your real income, straight from the chain.
 *
 * Real agent purchases are USDC transfers INTO your seller wallet (payTo). This
 * reads recent USDC Transfer logs where `to == payTo` so you can see who paid,
 * how much, and when — no database needed. For full history, link to BaseScan.
 */

import "server-only";
import { createPublicClient, http, parseAbiItem, formatUnits, getAddress, type Address } from "viem";
import { base } from "viem/chains";
import { getConfig, USDC_BASE } from "./config";
import { baseTransport } from "./base-transport";
import { kvGet, kvSet } from "./kv";
import { keepaliveEconomics, type KeepaliveEconomics } from "./keepalive-economics";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export interface RevenueResult {
  payTo: string | null;
  windowBlocks: number;
  count: number;
  /** Every USDC that arrived — what the chain says, not what was sold. */
  totalUsdc: string;
  /** What customers actually settled over x402. This is revenue. */
  settledUsdc?: string;
  settledCount?: number;
  /** Arrived without anybody buying anything: bridges, refunds, our own transfers. */
  nonSettlementUsdc?: string;
  nonSettlementCount?: number;
  /** Discovery spend against what outsiders paid — see keepalive-economics.ts. */
  keepalive?: KeepaliveEconomics | null;
  payments: Array<{
    from: string;
    amountUsdc: string;
    txHash: string;
    block: string;
    method?: string;
    isSettlement?: boolean;
  }>;
  rpcLimited?: boolean;
  note?: string;
  checkedAt: string;
}

export async function getRevenue(blocks = 5000): Promise<RevenueResult> {
  const cfg = getConfig();
  const now = new Date().toISOString();
  if (!cfg.payTo) {
    return { payTo: null, windowBlocks: 0, count: 0, totalUsdc: "0", payments: [], note: "PAY_TO_ADDRESS not set", checkedAt: now };
  }
  const payTo = getAddress(cfg.payTo) as Address;
  const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

  // Public Base RPC limits getLogs ranges; keep the window modest by default.
  // For a wider window, set BASE_RPC_URL to a dedicated RPC.
  const span = BigInt(Math.min(Math.max(blocks, 100), 10000));

  // Read the log window with one retry — the primary RPC (CDP Node) handles this
  // range fine, but a transient hiccup shouldn't immediately flip the dashboard
  // to "0 / rate-limited". Retry once before giving up.
  let logs;
  const readLogs = async () => {
    const latest = await client.getBlockNumber();
    const fromBlock = latest > span ? latest - span : 0n;
    return client.getLogs({
      address: USDC_BASE as Address,
      event: transferEvent,
      args: { to: payTo },
      fromBlock,
      toBlock: latest,
    });
  };
  try {
    try {
      logs = await readLogs();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      logs = await readLogs();
    }
  } catch {
    return {
      payTo,
      windowBlocks: Number(span),
      count: 0,
      totalUsdc: "0",
      payments: [],
      rpcLimited: true,
      note: "RPC log-range limit hit — narrow the window or use a dedicated RPC. Full history is always on BaseScan.",
      checkedAt: now,
    };
  }

  const total = logs.reduce((s, l) => s + (l.args.value ?? 0n), 0n);
  const recent = logs.slice(-100).reverse();
  const methods = await classifyAll(client, recent.map((l) => l.transactionHash));

  const payments = recent.map((l) => {
    const method = methods.get(l.transactionHash) ?? "unknown";
    return {
      from: l.args.from ?? "",
      amountUsdc: formatUnits(l.args.value ?? 0n, 6),
      txHash: l.transactionHash,
      block: String(l.blockNumber),
      method,
      /** Money a customer paid us for a service, as opposed to money that merely arrived. */
      isSettlement: method === "x402",
    };
  });

  const settled = payments
    .filter((p) => p.isSettlement)
    .reduce((s, p) => s + BigInt(Math.round(Number(p.amountUsdc) * 1e6)), 0n);
  const other = payments.filter((p) => !p.isSettlement);
  const otherTotal = other.reduce((s, p) => s + BigInt(Math.round(Number(p.amountUsdc) * 1e6)), 0n);

  return {
    payTo,
    windowBlocks: Number(span),
    count: logs.length,
    /** Everything that arrived. Kept because it is what the chain says. */
    totalUsdc: formatUnits(total, 6),
    /** What was actually sold. This is the revenue number. */
    settledUsdc: formatUnits(settled, 6),
    settledCount: payments.filter((p) => p.isSettlement).length,
    /** Arrived, but nobody bought anything: bridges, refunds, our own transfers. */
    nonSettlementUsdc: formatUnits(otherTotal, 6),
    nonSettlementCount: other.length,
    // What discovery costs against what it returns. Settled revenue includes our
    // own keepalive — money we paid ourselves to stay findable — so the ledger
    // subtracts it rather than letting the conveyor read as demand.
    keepalive: await keepaliveEconomics(Number(formatUnits(settled, 6))).catch(() => null),
    payments,
    checkedAt: now,
  };
}

/**
 * Was this incoming USDC a sale, or did it just arrive?
 *
 * The scan above reads USDC `Transfer` logs where `to == payTo`, which is every
 * way money can reach the wallet — and it was counting all of it as revenue. On
 * 2026-09-14 the operator moved funds off Base through a relay bridge and the
 * dashboard reported $8.89 of income: 5 USDC they had sent themselves from our
 * own buyer wallet, and 3.89 the bridge's solver delivered by `transferFrom`.
 * Nobody had bought anything. The panel was not describing the business.
 *
 * The distinction is in the transaction, not the log. An x402 settlement is
 * EIP-3009: the payer signs an authorization and the facilitator submits it, so
 * the call is `transferWithAuthorization` / `receiveWithAuthorization`. Money
 * moved any other way — a plain `transfer` someone sent by hand, a
 * `transferFrom` a bridge or DEX pulled under an allowance — is a balance
 * change, not a sale.
 *
 * Verified against known settlements on 2026-09-14: the $1 credit pack, a $0.10
 * pre-trade-gate call and a $0.002 keepalive all carry 0xe3ee160e; the bridge
 * delivery carried 0x23b872dd and the manual transfer 0xa9059cbb.
 */
const X402_SELECTORS = new Set(["0xe3ee160e", "0xef55bec6"]);
const METHOD_BY_SELECTOR: Record<string, string> = {
  "0xe3ee160e": "x402",
  "0xef55bec6": "x402",
  "0xa9059cbb": "transfer",
  "0x23b872dd": "transferFrom",
};

/**
 * A transaction's method never changes, so this is cached permanently. Without
 * it the dashboard would re-fetch up to a hundred transactions on every refresh
 * of a page that is polled.
 */
/** Structural, so this does not have to name viem's full client type — which is
 *  chain- and transport-parameterised and does not survive being passed around. */
type TxReader = { getTransaction: (args: { hash: `0x${string}` }) => Promise<{ input: string }> };

async function classifyAll(client: TxReader, hashes: readonly `0x${string}`[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unknown: `0x${string}`[] = [];

  for (const h of hashes) {
    const hit = await kvGet(`tx:method:${h}`).catch(() => null);
    if (hit) out.set(h, hit);
    else unknown.push(h);
  }

  // Small batches: this runs behind an owner-only route, but the public RPC
  // still rate-limits, and a slow dashboard is better than a broken one.
  for (let i = 0; i < unknown.length; i += 8) {
    const batch = unknown.slice(i, i + 8);
    await Promise.all(
      batch.map(async (h) => {
        try {
          const tx = await client.getTransaction({ hash: h });
          const sel = tx.input.slice(0, 10).toLowerCase();
          const method = METHOD_BY_SELECTOR[sel] ?? (X402_SELECTORS.has(sel) ? "x402" : `other:${sel}`);
          out.set(h, method);
          await kvSet(`tx:method:${h}`, method).catch(() => {});
        } catch {
          // Unread, not unclassified: leaving it out of the settled total is the
          // conservative direction — it understates revenue rather than
          // inventing it, which is the mistake this whole change exists to undo.
          out.set(h, "unknown");
        }
      }),
    );
  }
  return out;
}
