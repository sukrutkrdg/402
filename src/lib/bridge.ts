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
const ZERO = "0x0000000000000000000000000000000000000000";
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

interface MintRow {
  block_timestamp?: string;
  transaction_hash?: string;
  value?: string;
}

const fmtUsdc = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;

export async function freshBridge(params: Record<string, string>) {
  const wallet = (params.wallet || params.address || params.account || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("Provide a valid 0x... wallet address (wallet=)");
  const w = getAddress(wallet);
  const wl = w.toLowerCase();
  const days = Math.min(90, Math.max(1, parseInt(params.days || "30", 10) || 30));

  // 1) Recent USDC mints to this wallet (Transfer from 0x0) — freshly issued or
  //    bridged USDC. Bounded window + address filter keeps this under the read cap.
  const mints = await cdpSql<MintRow>(
    `SELECT block_timestamp, transaction_hash, toString(parameters['value']) AS value FROM base.events WHERE address='${USDC}' AND event_name='Transfer' AND parameters['from']='${ZERO}' AND parameters['to']='${wl}' AND block_timestamp > now() - INTERVAL ${days} DAY ORDER BY block_timestamp DESC LIMIT 50`,
  );
  if (mints === null) throw new Error("USDC mint data unavailable (data provider) — try again shortly");

  if (mints.length === 0) {
    return finish({
      wallet: w,
      windowDays: days,
      verdict: "no_fresh_usdc",
      freshUsdcMints: 0,
      recommendation: `No freshly-minted USDC arrived at this wallet in ${days}d — its USDC (if any) was received as ordinary transfers, not minted/bridged in. Widen days= to look further back.`,
      note: "Detects freshly bridged/issued USDC (CCTP + native mints) to a Base wallet and labels the source chain. wallet= required; days= optional (default 30, max 90). Not financial advice.",
    });
  }

  // 2) Which of those mint txs are CCTP receives — and from which source chain.
  const txs = mints.map((m) => `'${String(m.transaction_hash ?? "").toLowerCase()}'`).filter((t) => t !== "''");
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

  const events = mints.map((m) => {
    const tx = String(m.transaction_hash ?? "").toLowerCase();
    let value = 0n;
    try { value = BigInt(String(m.value ?? "0")); } catch { /* keep 0 */ }
    const sourceChain = cctpByTx.get(tx) ?? null;
    return {
      at: m.block_timestamp ?? null,
      amount: fmtUsdc(value),
      valueRaw: value,
      via: sourceChain ? "cctp" : "native_mint",
      sourceChain, // null for native/Coinbase-issued mints
      txHash: m.transaction_hash ?? null,
    };
  });

  const bridged = events.filter((e) => e.via === "cctp");
  const totalFresh = events.reduce((a, e) => a + e.valueRaw, 0n);
  const bridgedTotal = bridged.reduce((a, e) => a + e.valueRaw, 0n);
  const sources = [...new Set(bridged.map((e) => e.sourceChain).filter(Boolean))] as string[];
  const mostRecent = events[0];

  const verdict = bridged.length ? "freshly_bridged" : "native_issued";

  return finish({
    wallet: w,
    windowDays: days,
    verdict, // freshly_bridged | native_issued | no_fresh_usdc
    freshUsdcMints: events.length,
    freshUsdcTotal: fmtUsdc(totalFresh),
    cctpBridgedCount: bridged.length,
    cctpBridgedTotal: fmtUsdc(bridgedTotal),
    sourceChains: sources,
    mostRecentAt: mostRecent?.at ?? null,
    events: events.slice(0, 25).map(({ valueRaw, ...e }) => e),
    recommendation:
      verdict === "freshly_bridged"
        ? `This wallet received ${bridged.length} CCTP-bridged USDC mint(s) (${fmtUsdc(bridgedTotal)}) in ${days}d from ${sources.length ? sources.join(", ") : "another chain"} — fresh cross-chain capital, newest ${mostRecent?.at ?? ""}. New money arriving via bridge; factor that into flow/intent reads.`
        : `This wallet received ${events.length} freshly-minted USDC (${fmtUsdc(totalFresh)}) in ${days}d, but none matched a CCTP receive — likely native issuance (e.g. Coinbase) rather than a cross-chain bridge.`,
    note: "Detects freshly bridged/issued USDC to a Base wallet: recent USDC mints correlated with Circle CCTP receives to label the SOURCE CHAIN (bridged-from-X) vs native issuance. The cross-chain inflow read no other Base tool serves. wallet= required; days= optional (default 30, max 90). Not financial advice.",
  });
}
