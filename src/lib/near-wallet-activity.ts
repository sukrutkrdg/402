/**
 * NEAR wallet activity — what has this account been doing? The history an
 * agent reads before paying, trusting or copying a wallet: its recent
 * transactions grouped into NEAR sent and received, contracts called, token
 * flows in and out, and who it deals with most, plus a one-line summary.
 *
 * Current state (balances, keys) is near-account's job, from the RPC; history
 * needs an indexer, so this reads NearBlocks. The window is the most recent
 * transactions and token transfers (up to `limit` of each), not all time, and
 * the response says what it covered.
 */

import "server-only";
import { NEAR_ACCOUNT_RE, formatUnits, accountKind } from "./near-rpc";
import { nearblocks, nsToIso, toBigInt } from "./nearblocks";

const YOCTO = 24;

interface NbAction {
  action?: string;
  method?: string | null;
  deposit?: string | number;
}
interface NbTxn {
  transaction_hash: string;
  signer_account_id: string;
  receiver_account_id: string;
  block_timestamp: string | number;
  actions?: NbAction[] | null;
  actions_agg?: { deposit?: string | number } | null;
  outcomes?: { status?: boolean | null } | null;
}
interface NbFtTxn {
  transaction_hash?: string;
  involved_account_id?: string | null;
  delta_amount?: string | number;
  cause?: string;
  block_timestamp?: string | number;
  ft?: { contract?: string; symbol?: string; decimals?: number } | null;
}

const count = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const top = <K>(m: Map<K, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const human = (raw: bigint, decimals: number) => (raw < 0n ? "-" : "") + formatUnits((raw < 0n ? -raw : raw).toString(), decimals);

export async function nearWalletActivity(params: Record<string, string>) {
  const account = (params.account || params.address || "").trim().toLowerCase();
  if (!NEAR_ACCOUNT_RE.test(account)) throw new Error("Provide a NEAR account, e.g. alice.near or a 64-hex implicit account");
  const limit = params.limit ? Number(params.limit) : 25;
  if (!Number.isInteger(limit) || limit < 5 || limit > 50) throw new Error("limit is how many recent transactions to read: 5–50 (default 25)");
  const checkedAt = new Date().toISOString();

  const enc = encodeURIComponent(account);
  const [tx, ft] = await Promise.all([
    nearblocks<{ txns?: NbTxn[] }>(`/v1/account/${enc}/txns-only?per_page=${limit}&order=desc`),
    nearblocks<{ txns?: NbFtTxn[] }>(`/v1/account/${enc}/ft-txns?per_page=${limit}&order=desc`),
  ]);
  const txns = Array.isArray(tx.txns) ? tx.txns : [];
  const fts = Array.isArray(ft.txns) ? ft.txns : [];

  // ── transactions ────────────────────────────────────────────────────────
  let sent = 0,
    received = 0,
    failed = 0;
  let nearOut = 0n,
    nearIn = 0n;
  const methods = new Map<string, number>();
  const counterparties = new Map<string, number>();
  const recent = txns.slice(0, 10).map((t) => {
    const out = t.signer_account_id === account;
    const other = out ? t.receiver_account_id : t.signer_account_id;
    const deposit = toBigInt(t.actions_agg?.deposit) ?? 0n;
    const acts = (t.actions ?? []).map((a) => (a.method ? `${a.action ?? "FUNCTION_CALL"}:${a.method}` : a.action ?? "?"));
    return {
      at: nsToIso(t.block_timestamp),
      hash: t.transaction_hash,
      direction: out ? ("out" as const) : ("in" as const),
      counterparty: other === account ? null : other,
      actions: acts,
      nearAmount: deposit > 0n ? formatUnits(deposit.toString(), YOCTO) : "0",
      success: t.outcomes?.status ?? null,
    };
  });
  for (const t of txns) {
    const out = t.signer_account_id === account;
    if (out) sent++;
    else received++;
    if (t.outcomes?.status === false) failed++;
    const other = out ? t.receiver_account_id : t.signer_account_id;
    if (other && other !== account) count(counterparties, other);
    const deposit = toBigInt(t.actions_agg?.deposit) ?? 0n;
    // A deposit moves NEAR from signer to receiver; a self-call moves nothing.
    if (deposit > 0n && t.receiver_account_id !== t.signer_account_id) {
      if (out) nearOut += deposit;
      else if (t.receiver_account_id === account) nearIn += deposit;
    }
    for (const a of t.actions ?? []) if (a.method && out) count(methods, `${t.receiver_account_id}.${a.method}`);
  }

  // ── token flows ─────────────────────────────────────────────────────────
  const flows = new Map<string, { symbol: string; decimals: number; in: bigint; out: bigint; transfers: number }>();
  for (const e of fts) {
    const contract = e.ft?.contract;
    const delta = toBigInt(e.delta_amount);
    if (!contract || delta === null || delta === 0n) continue;
    const f = flows.get(contract) ?? { symbol: e.ft?.symbol ?? contract, decimals: e.ft?.decimals ?? 0, in: 0n, out: 0n, transfers: 0 };
    if (delta > 0n) f.in += delta;
    else f.out -= delta;
    f.transfers++;
    flows.set(contract, f);
    if (e.involved_account_id && e.involved_account_id !== account) count(counterparties, e.involved_account_id);
  }
  const tokenFlows = [...flows.entries()]
    .sort((a, b) => b[1].transfers - a[1].transfers)
    .map(([contract, f]) => ({
      token: contract,
      symbol: f.symbol,
      received: human(f.in, f.decimals),
      sent: human(f.out, f.decimals),
      net: human(f.in - f.out, f.decimals),
      transfers: f.transfers,
    }));

  // ── window and signals ──────────────────────────────────────────────────
  const times = [...txns.map((t) => nsToIso(t.block_timestamp)), ...fts.map((e) => nsToIso(e.block_timestamp))].filter(
    (x): x is string => Boolean(x),
  );
  const newest = times.length ? times.reduce((a, b) => (a > b ? a : b)) : null;
  const oldest = times.length ? times.reduce((a, b) => (a < b ? a : b)) : null;
  const idleDays = newest ? Math.floor((Date.now() - Date.parse(newest)) / 86_400_000) : null;

  const signals: string[] = [];
  if (!txns.length && !fts.length) signals.push("No transactions or token transfers found — a new, unused or unknown account.");
  if (idleDays !== null && idleDays > 90) signals.push(`Inactive: last activity ${idleDays} days ago.`);
  if (txns.length >= 5 && failed / txns.length > 0.3)
    signals.push(`${failed} of ${txns.length} recent transactions failed — a misbehaving bot or a wallet being drained of gas.`);
  if (sent === 0 && received > 0) signals.push("Only receives, never signs — a deposit address, contract or cold wallet.");

  const topCp = top(counterparties, 5).map(([id, n]) => ({ account: id, interactions: n, kind: accountKind(id) }));
  const topMethods = top(methods, 5).map(([m, n]) => ({ call: m, times: n }));

  const parts: string[] = [];
  if (txns.length) parts.push(`${txns.length} recent transactions (${sent} signed, ${received} received${failed ? `, ${failed} failed` : ""})`);
  if (nearOut || nearIn) parts.push(`NEAR out ${formatUnits(nearOut.toString(), YOCTO)} / in ${formatUnits(nearIn.toString(), YOCTO)}`);
  if (tokenFlows.length) parts.push(`moves ${tokenFlows.slice(0, 3).map((f) => f.symbol).join(", ")}`);
  if (topMethods.length) parts.push(`mostly calls ${topMethods[0].call}`);
  if (topCp.length) parts.push(`deals most with ${topCp[0].account}`);
  if (newest) parts.push(`last active ${newest.slice(0, 10)}`);

  return {
    chain: "near" as const,
    account,
    kind: accountKind(account),
    checkedAt,
    summary: parts.length ? `${parts.join("; ")}.` : "No activity found.",
    window: { transactions: txns.length, tokenTransfers: fts.length, from: oldest, to: newest },
    near: { sent: formatUnits(nearOut.toString(), YOCTO), received: formatUnits(nearIn.toString(), YOCTO) },
    tokenFlows,
    topCounterparties: topCp,
    topCalls: topMethods,
    signals,
    recent,
    source: "NearBlocks indexer",
  };
}
