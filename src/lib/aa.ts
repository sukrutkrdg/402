/**
 * Gas Sponsor / Account-Abstraction profile — who pays this Base wallet's gas?
 *
 * Base pushes ERC-4337 smart accounts hard (Base Account / Coinbase Smart Wallet),
 * and a smart account's gas can be paid by a PAYMASTER instead of the account
 * itself. That is invisible to every "does this wallet spend ETH" heuristic and
 * to approval/delegation tools — yet it's a real signal: a fully-sponsored account
 * is typically app- or agent-operated, and its gas spend tells you nothing about
 * its funding. This reads a wallet's UserOperationEvents from BOTH EntryPoints
 * (v0.6 + v0.7) and answers: is it a smart account, how active, and WHO sponsors
 * its gas. The first onchain gas-sponsorship read on Base — no other tool serves
 * it. Deterministic, CDP-indexed, no LLM. Not financial advice.
 *
 * UserOperationEvent(bytes32 indexed userOpHash, address indexed sender,
 *   address indexed paymaster, uint256 nonce, bool success,
 *   uint256 actualGasCost, uint256 actualGasUsed) — paymaster == 0x0 means the
 * account paid its own gas.
 */

import "server-only";
import { getAddress } from "viem";
import { cdpSql } from "./covalent";
import { finish } from "./envelope";

const ENTRYPOINTS = [
  { v: "0.6", addr: "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789" },
  { v: "0.7", addr: "0x0000000071727de22e5e9d8baf0edac6f37da032" },
] as const;
const ZERO = "0x0000000000000000000000000000000000000000";

// Best-effort labels for recognized paymasters. Deliberately conservative — only
// entries we're confident about; every other sponsor is reported by address with
// known:false rather than risk a wrong label. Extend as sponsors are identified.
const KNOWN_PAYMASTERS: Record<string, string> = {};

interface AggRow {
  pm?: string;
  n?: string;
  ok?: string;
  gas?: string;
}

function fmtEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export async function gasSponsor(params: Record<string, string>) {
  const wallet = (params.wallet || params.address || params.account || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("Provide a valid 0x... wallet address (wallet=)");
  const w = getAddress(wallet);
  const wl = w.toLowerCase();
  const days = Math.min(90, Math.max(1, parseInt(params.days || "30", 10) || 30));

  // One aggregation per EntryPoint: group this sender's UserOperationEvents by
  // paymaster (server-side count/gas sum, so very active accounts don't blow a
  // row cap). Filtering by the decoded sender keeps each query to a few rows.
  const perPm = new Map<string, { ops: number; ok: number; gas: bigint }>();
  let dataAvailable = false;
  for (const ep of ENTRYPOINTS) {
    const rows = await cdpSql<AggRow>(
      `SELECT parameters['paymaster'] AS pm, count() AS n, countIf(toString(parameters['success'])='true') AS ok, sum(toUInt256OrZero(toString(parameters['actualGasCost']))) AS gas FROM base.events WHERE address='${ep.addr}' AND event_name='UserOperationEvent' AND parameters['sender']='${wl}' AND block_timestamp > now() - INTERVAL ${days} DAY GROUP BY pm ORDER BY n DESC`,
    );
    if (rows === null) continue; // one provider hiccup shouldn't sink the other EntryPoint
    dataAvailable = true;
    for (const r of rows) {
      const pm = String(r.pm ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(pm)) continue;
      const e = perPm.get(pm) ?? { ops: 0, ok: 0, gas: 0n };
      e.ops += Number(r.n ?? 0);
      e.ok += Number(r.ok ?? 0);
      try { e.gas += BigInt(String(r.gas ?? "0")); } catch { /* keep count */ }
      perPm.set(pm, e);
    }
  }
  if (!dataAvailable) throw new Error("Account-abstraction data unavailable (data provider) — try again shortly");

  const totalOps = [...perPm.values()].reduce((a, e) => a + e.ops, 0);
  if (totalOps === 0) {
    return finish({
      wallet: w,
      windowDays: days,
      verdict: "not_smart_account",
      smartAccount: false,
      userOps: 0,
      recommendation: `No ERC-4337 UserOperations from this address on Base in ${days}d — it isn't operating as a smart account (likely a plain EOA, or inactive). Gas-sponsorship only applies to smart accounts; widen days= if you expected activity.`,
      note: "Reads a Base wallet's ERC-4337 account-abstraction profile from EntryPoint v0.6+v0.7 UserOperationEvents. wallet= required; days= optional (default 30, max 90). Not financial advice.",
    });
  }

  const okOps = [...perPm.values()].reduce((a, e) => a + e.ok, 0);
  const totalGas = [...perPm.values()].reduce((a, e) => a + e.gas, 0n);
  const selfPaid = perPm.get(ZERO) ?? { ops: 0, ok: 0, gas: 0n };
  const sponsored = [...perPm.entries()].filter(([pm]) => pm !== ZERO);
  const sponsoredOps = sponsored.reduce((a, [, e]) => a + e.ops, 0);
  const sponsoredGas = sponsored.reduce((a, [, e]) => a + e.gas, 0n);

  const sponsors = sponsored
    .sort((a, b) => b[1].ops - a[1].ops)
    .slice(0, 10)
    .map(([pm, e]) => ({
      paymaster: getAddress(pm),
      label: KNOWN_PAYMASTERS[pm] ?? null,
      known: pm in KNOWN_PAYMASTERS,
      ops: e.ops,
      gasEth: fmtEth(e.gas),
      sharePct: +((100 * e.ops) / totalOps).toFixed(1),
    }));

  const sponsoredPct = +((100 * sponsoredOps) / totalOps).toFixed(1);
  const verdict = sponsoredOps === 0 ? "self_paid" : selfPaid.ops === 0 ? "fully_sponsored" : "mixed";

  return finish({
    wallet: w,
    windowDays: days,
    verdict, // self_paid | fully_sponsored | mixed | not_smart_account
    smartAccount: true,
    userOps: totalOps,
    successPct: +((100 * okOps) / totalOps).toFixed(1),
    totalGasEth: fmtEth(totalGas),
    sponsoredPct,
    selfPaidPct: +((100 * selfPaid.ops) / totalOps).toFixed(1),
    distinctSponsors: sponsored.length,
    sponsoredGasEth: fmtEth(sponsoredGas),
    sponsors, // paymasters funding this account's gas, most-used first
    recommendation:
      verdict === "self_paid"
        ? `ERC-4337 smart account paying its OWN gas across ${totalOps} op(s) in ${days}d (${fmtEth(totalGas)} ETH). No third party sponsors it.`
        : verdict === "fully_sponsored"
          ? `ERC-4337 smart account whose gas is 100% SPONSORED (${totalOps} op(s), ${fmtEth(totalGas)} ETH) by ${sponsored.length} paymaster(s), led by ${sponsors[0]?.paymaster}. It spends no ETH on gas — a pattern typical of app- or agent-operated accounts; don't infer funding or solvency from gas spend.`
          : `ERC-4337 smart account: ${sponsoredPct}% of ${totalOps} op(s) gas-sponsored by ${sponsored.length} paymaster(s), the rest self-paid.`,
    note: "Reads a Base wallet's ERC-4337 account-abstraction profile from EntryPoint v0.6+v0.7 UserOperationEvents: whether it's a smart account, op count and success rate, and WHO pays its gas (itself vs which paymaster). The agent-native 'who funds this account's gas' check no other Base tool serves. wallet= required; days= optional (default 30, max 90). Not financial advice.",
  });
}
