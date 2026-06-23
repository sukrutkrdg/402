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

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export interface RevenueResult {
  payTo: string | null;
  windowBlocks: number;
  count: number;
  totalUsdc: string;
  payments: Array<{ from: string; amountUsdc: string; txHash: string; block: string }>;
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
  const client = createPublicClient({ chain: base, transport: http(cfg.rpcUrl, { timeout: 8000 }) });

  // Public Base RPC limits getLogs ranges; keep the window modest by default.
  // For a wider window, set BASE_RPC_URL to a dedicated RPC.
  const span = BigInt(Math.min(Math.max(blocks, 100), 10000));

  let logs;
  try {
    const latest = await client.getBlockNumber();
    const fromBlock = latest > span ? latest - span : 0n;
    logs = await client.getLogs({
      address: USDC_BASE as Address,
      event: transferEvent,
      args: { to: payTo },
      fromBlock,
      toBlock: latest,
    });
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
  const payments = logs
    .map((l) => ({
      from: l.args.from ?? "",
      amountUsdc: formatUnits(l.args.value ?? 0n, 6),
      txHash: l.transactionHash,
      block: String(l.blockNumber),
    }))
    .reverse()
    .slice(0, 100);

  return {
    payTo,
    windowBlocks: Number(span),
    count: logs.length,
    totalUsdc: formatUnits(total, 6),
    payments,
    checkedAt: now,
  };
}
