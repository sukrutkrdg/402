/**
 * Base Withdrawal Finalizer — when can a Base→L1 withdrawal be finalized?
 *
 * Beryl (2026-06-25) cut the single-proof withdrawal challenge window from 7 days
 * to 5, while a dual-proof fast path finalizes in ~1 day. Given a Base
 * withdrawal-initiation tx, this decodes the L2ToL1MessagePasser MessagePassed
 * event (the withdrawalHash + target + value an agent needs to prove/finalize on
 * L1) and estimates the finalization windows under the post-Beryl rules.
 *
 * ETAs are estimated from initiation — live prove/finalize state lives on L1 and
 * isn't read here (Base RPC only).
 */

import "server-only";
import { createPublicClient, decodeEventLog, parseAbiItem } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

// Predeploy that records L2→L1 messages (withdrawals) — same on every OP-stack chain.
const MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";
const MESSAGE_PASSED = parseAbiItem(
  "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
);

const DAY = 86_400;
const STANDARD_DELAY = 5 * DAY; // Beryl: single-proof window cut 7d → 5d
const FAST_DELAY = 1 * DAY; // dual-proof fast path
const PROVE_LAG = 3600; // ~1h conservative estimate for the output root + prove step

export async function baseWithdrawal(params: Record<string, string>) {
  const tx = (params.tx || params.hash || params.txHash || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    throw new Error("Provide a Base withdrawal-initiation txHash (tx=0x…)");
  }

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: tx as `0x${string}` });
  } catch {
    throw new Error("Transaction not found on Base — check the hash (must be a Base L2 tx)");
  }

  interface WArgs { nonce?: bigint; sender?: string; target?: string; value?: bigint; withdrawalHash?: string }
  let args: WArgs | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MESSAGE_PASSER.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [MESSAGE_PASSED], data: log.data, topics: log.topics });
      if (ev.eventName === "MessagePassed") {
        args = ev.args as unknown as WArgs;
        break;
      }
    } catch {
      /* not the event we want */
    }
  }
  if (!args) {
    throw new Error("No L2→L1 withdrawal (MessagePassed) in that transaction — it isn't a Base withdrawal initiation");
  }

  let initiatedAt: number | null = null;
  try {
    const b = await client.getBlock({ blockNumber: receipt.blockNumber });
    initiatedAt = Number(b.timestamp);
  } catch {
    /* timestamp best-effort */
  }

  const now = Math.floor(Date.now() / 1000);
  const provableAt = initiatedAt ? initiatedAt + PROVE_LAG : null;
  const fastAt = provableAt ? provableAt + FAST_DELAY : null;
  const standardAt = provableAt ? provableAt + STANDARD_DELAY : null;
  const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString() : null);
  const remaining = (t: number | null) => (t ? Math.max(0, t - now) : null);
  const days = (secs: number | null) => (secs === null ? null : +(secs / DAY).toFixed(2));

  return {
    tx,
    isBaseWithdrawal: true,
    withdrawalHash: args.withdrawalHash ?? null,
    nonce: args.nonce?.toString() ?? null,
    sender: args.sender ?? null,
    target: args.target ?? null,
    value: args.value?.toString() ?? null,
    initiatedAt: iso(initiatedAt),
    estimates: {
      provableFrom: iso(provableAt),
      finalizeFastPath: { at: iso(fastAt), inDays: days(remaining(fastAt)), window: "~1 day (dual-proof fast path)" },
      finalizeStandard: { at: iso(standardAt), inDays: days(remaining(standardAt)), window: "5 days (single-proof, post-Beryl)" },
    },
    verdict: standardAt && now >= standardAt ? "likely_finalizable" : "waiting",
    recommendation:
      standardAt && now >= standardAt
        ? "The standard 5-day window has elapsed since initiation — if the withdrawal was proven on L1, it should be finalizable now. Confirm on L1 and finalize with the withdrawalHash."
        : `Prove on L1 once the output root is posted (~1h), then wait the challenge window: ~1 day (dual-proof fast path) or 5 days (standard, post-Beryl). ETA is measured from initiation; the clock actually starts at your L1 prove tx.`,
    note: "Beryl (2026-06-25) cut the single-proof withdrawal window 7d→5d; a dual-proof fast path finalizes in ~1 day. Decodes the withdrawal (withdrawalHash/target/value) from the Base initiation tx and estimates the windows — live prove/finalize state is on L1 and not read here. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
