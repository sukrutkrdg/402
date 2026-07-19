/**
 * Fresh Bridge — is this wallet's USDC freshly bridged in, and from where?
 *
 * When USDC arrives on Base via Circle CCTP, it's MINTED to the recipient
 * (Transfer from 0x0) inside a transaction that also carries a CCTP
 * MessageReceived carrying the SOURCE DOMAIN (which chain it came from). Freshly
 * bridged capital is a real signal for trading/liquidation agents (new money,
 * possible cross-chain hop). Reads a wallet's recent USDC mints and correlates
 * them with CCTP receives to label each as bridged-from-<chain> vs natively
 * issued. Cross-chain inflow — a gap no other Base tool serves. Not financial
 * advice.
 */

import "server-only";
import { getAddress } from "viem";
import { cdpSql } from "./covalent";
import { finish } from "./envelope";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// Circle CCTP v1 MessageTransmitter on Base (destination-side MessageReceived).
const CCTP_MESSAGE_TRANSMITTER = "0xad09780d193884d503182ad4588450c416d6f9d4";

// CCTP domain → source chain name.
const CCTP_DOMAIN: Record<string, string> = {
  "0": "Ethereum",
  "1": "Avalanche",
  "2": "OP Mainnet",
  "3": "Arbitrum",
  "4": "Noble",
  "5": "Solana",
  "6": "Base",
  "7": "Polygon PoS",
  "10": "Unichain",
};

interface InRow {
  block_timestamp?: string;
  transaction_hash?: string;
  from?: string;
  value?: string;
}

const fmtUsdc = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;

export async function freshBridge(params: Record<string, string>) {
  const wallet = (params.wallet || params.address || params.account || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("Provide a valid 0x... wallet address (wallet=)");
  const w = getAddress(wallet);
  const wl = w.toLowerCase();
  const days = Math.min(90, Math.max(1, parseInt(params.days || "30", 10) || 30));

  // 1) The wallet's incoming USDC (bounded window + to-filter → under the read cap).
  //    CCTP settles USDC to the recipient either by minting straight to it
  //    (from 0x0) or via a relayer that forwards it — filtering by `to` catches
  //    both, then we correlate the tx with a CCTP MessageReceived below.
  const incoming = await cdpSql<InRow>(
    `SELECT block_timestamp, transaction_hash, parameters['from'] AS from, toString(parameters['value']) AS value FROM base.events WHERE address='${USDC}' AND event_name='Transfer' AND parameters['to']='${wl}' AND block_timestamp > now() - INTERVAL ${days} DAY ORDER BY block_timestamp DESC LIMIT 150`,
  );
  if (incoming === null) throw new Error("USDC inflow data unavailable (data provider) — try again shortly");

  if (incoming.length === 0) {
    return finish({
      wallet: w,
      windowDays: days,
      verdict: "no_recent_usdc",
      incomingUsdc: 0,
      recommendation: `This wallet received no USDC on Base in ${days}d — nothing to trace for a bridge. Widen days= to look further back.`,
      note: "Detects freshly bridged USDC (via Circle CCTP) to a Base wallet and labels the source chain. wallet= required; days= optional (default 30, max 90). Not financial advice.",
    });
  }

  // 2) Which of those inflow txs are CCTP receives — and from which source chain.
  const txs = [...new Set(incoming.map((m) => String(m.transaction_hash ?? "").toLowerCase()).filter(Boolean))].map((t) => `'${t}'`);
  const cctpByTx = new Map<string, string>(); // tx -> source chain name
  if (txs.length) {
    const recv = await cdpSql<{ tx?: string; sd?: string }>(
      `SELECT transaction_hash AS tx, toString(parameters['sourceDomain']) AS sd FROM base.events WHERE address='${CCTP_MESSAGE_TRANSMITTER}' AND event_name='MessageReceived' AND transaction_hash IN (${txs.join(",")}) AND block_timestamp > now() - INTERVAL ${days} DAY`,
    );
    for (const r of recv ?? []) {
      const tx = String(r.tx ?? "").toLowerCase();
      const sd = String(r.sd ?? "");
      if (tx) cctpByTx.set(tx, CCTP_DOMAIN[sd] ?? `domain ${sd}`);
    }
  }

  const rows = incoming.map((m) => {
    const tx = String(m.transaction_hash ?? "").toLowerCase();
    let value = 0n;
    try { value = BigInt(String(m.value ?? "0")); } catch { /* keep 0 */ }
    const sourceChain = cctpByTx.get(tx) ?? null;
    return { at: m.block_timestamp ?? null, valueRaw: value, sourceChain, txHash: m.transaction_hash ?? null };
  });

  const bridged = rows.filter((e) => e.sourceChain !== null);
  const totalIncoming = rows.reduce((a, e) => a + e.valueRaw, 0n);
  const bridgedTotal = bridged.reduce((a, e) => a + e.valueRaw, 0n);
  const sources = [...new Set(bridged.map((e) => e.sourceChain).filter(Boolean))] as string[];
  const mostRecentBridge = bridged[0];

  const verdict = bridged.length ? "freshly_bridged" : "received_no_bridge";

  return finish({
    wallet: w,
    windowDays: days,
    verdict, // freshly_bridged | received_no_bridge | no_recent_usdc
    incomingUsdc: rows.length,
    incomingUsdcTotal: fmtUsdc(totalIncoming),
    cctpBridgedCount: bridged.length,
    cctpBridgedTotal: fmtUsdc(bridgedTotal),
    sourceChains: sources,
    mostRecentBridgeAt: mostRecentBridge?.at ?? null,
    bridges: bridged.slice(0, 25).map((e) => ({ at: e.at, amount: fmtUsdc(e.valueRaw), sourceChain: e.sourceChain, txHash: e.txHash })),
    recommendation:
      verdict === "freshly_bridged"
        ? `This wallet received ${bridged.length} CCTP-bridged USDC transfer(s) (${fmtUsdc(bridgedTotal)}) in ${days}d from ${sources.length ? sources.join(", ") : "another chain"} — fresh cross-chain capital, newest ${mostRecentBridge?.at ?? ""}. New money arriving via bridge; factor that into flow/intent reads.`
        : `This wallet received ${rows.length} USDC transfer(s) (${fmtUsdc(totalIncoming)}) in ${days}d, but none arrived via a CCTP bridge — its USDC came from ordinary onchain transfers, not fresh cross-chain inflow.`,
    note: "Detects freshly bridged USDC to a Base wallet: recent incoming USDC correlated with Circle CCTP receives to label the SOURCE CHAIN (bridged-from-X). Catches both direct-mint and relayer-forwarded CCTP settlement. The cross-chain inflow read no other Base tool serves. wallet= required; days= optional (default 30, max 90). Not financial advice.",
  });
}
