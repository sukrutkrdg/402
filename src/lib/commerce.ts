/**
 * Commerce Payments (base/commerce-payments) services — the auth/capture escrow
 * protocol on Base (AuthCaptureEscrow). Two-phase onchain payments: an operator
 * authorizes funds into escrow (PaymentAuthorized), then captures them for the
 * merchant (PaymentCaptured) or the flow ends in void/reclaim/refund. Live on
 * mainnet with zero third-party tooling — these are the first reconciliation
 * and trust reads for it.
 *
 * Event shapes (AuthCaptureEscrow.sol):
 *   PaymentCharged(hash idx, PaymentInfo, amount, tokenCollector, feeAmount, feeReceiver)
 *   PaymentAuthorized(hash idx, PaymentInfo, amount, tokenCollector)
 *   PaymentCaptured(hash idx, amount, feeAmount, feeReceiver)
 *   PaymentVoided/PaymentReclaimed(hash idx, amount)
 *   PaymentRefunded(hash idx, amount, tokenCollector)
 * PaymentInfo = (operator, payer, receiver, token, maxAmount, preApprovalExpiry,
 * authorizationExpiry, refundExpiry, minFeeBps, maxFeeBps, feeReceiver, salt).
 */

import "server-only";
import { getAddress } from "viem";
import { cdpSql } from "./covalent";
import { finish } from "./envelope";

export const AUTH_CAPTURE_ESCROW = "0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const validAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test((a ?? "").trim());

interface PayInfo {
  operator: string | null;
  payer: string | null;
  receiver: string | null;
  token: string | null;
  maxAmount: string;
  preApprovalExpiry: number | null;
  authorizationExpiry: number | null;
}

/** CDP SQL renders the PaymentInfo tuple either as a nested object or as a flat
 * "{0xa 0xb … 123 456}" string (same quirk as SpendPermission) — parse both. */
function parsePaymentInfo(v: unknown): PayInfo | null {
  const empty: PayInfo = { operator: null, payer: null, receiver: null, token: null, maxAmount: "0", preApprovalExpiry: null, authorizationExpiry: null };
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const g = (k: string) => (typeof o[k] === "string" && validAddr(o[k] as string) ? getAddress(o[k] as string) : null);
    if (o.operator || o.payer) {
      return {
        operator: g("operator"), payer: g("payer"), receiver: g("receiver"), token: g("token"),
        maxAmount: String(o.maxAmount ?? "0"),
        preApprovalExpiry: Number(o.preApprovalExpiry ?? 0) || null,
        authorizationExpiry: Number(o.authorizationExpiry ?? 0) || null,
      };
    }
  }
  if (typeof v === "string") {
    const toks = v.replace(/^[{[(]|[}\])]$/g, "").split(/[\s,]+/).filter(Boolean);
    const addrs = toks.filter((t) => validAddr(t));
    const nums = toks.filter((t) => /^\d+$/.test(t));
    if (addrs.length >= 4) {
      return {
        operator: getAddress(addrs[0]), payer: getAddress(addrs[1]), receiver: getAddress(addrs[2]), token: getAddress(addrs[3]),
        maxAmount: nums[0] ?? "0",
        preApprovalExpiry: nums[1] ? Number(nums[1]) : null,
        authorizationExpiry: nums[2] ? Number(nums[2]) : null,
      };
    }
  }
  return empty;
}

interface EscrowRow {
  event_name?: string;
  block_timestamp?: string;
  topics?: string[];
  parameters?: Record<string, unknown>;
  transaction_hash?: string;
}

async function fetchEscrowEvents(days: number): Promise<{ rows: EscrowRow[]; truncated: boolean }> {
  const rows = await cdpSql<EscrowRow>(
    `SELECT event_name, block_timestamp, topics, parameters, transaction_hash FROM base.events WHERE address = '${AUTH_CAPTURE_ESCROW.toLowerCase()}' AND block_timestamp > now() - INTERVAL ${days} DAY ORDER BY block_timestamp ASC LIMIT 5000`,
  );
  if (rows === null) throw new Error("Commerce escrow event data unavailable (data provider) — try again shortly");
  return { rows, truncated: rows.length >= 5000 };
}

interface Payment {
  hash: string;
  time: string | null;
  kind: "charged" | "authorized";
  info: PayInfo;
  authorizedAmount: bigint;
  capturedAmount: bigint;
  feeAmount: bigint;
  voided: boolean;
  reclaimed: boolean;
  refundedAmount: bigint;
  lastEventTime: string | null;
  txHash: string | null;
}

function buildPayments(rows: EscrowRow[]): Map<string, Payment> {
  const payments = new Map<string, Payment>();
  const big = (v: unknown) => { try { return BigInt(String(v ?? "0")); } catch { return 0n; } };
  for (const r of rows) {
    const name = r.event_name ?? "";
    const hash = String(r.topics?.[1] ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) continue;
    const p = r.parameters ?? {};
    if (name === "PaymentAuthorized" || name === "PaymentCharged") {
      const existing = payments.get(hash);
      const info = parsePaymentInfo(p.paymentInfo) ?? parsePaymentInfo(p[1]);
      const amount = big(p.amount);
      if (existing) {
        existing.authorizedAmount += amount;
        if (name === "PaymentCharged") { existing.capturedAmount += amount; existing.feeAmount += big(p.feeAmount); }
        existing.lastEventTime = r.block_timestamp ?? existing.lastEventTime;
      } else {
        payments.set(hash, {
          hash, time: r.block_timestamp ?? null,
          kind: name === "PaymentCharged" ? "charged" : "authorized",
          info: info ?? { operator: null, payer: null, receiver: null, token: null, maxAmount: "0", preApprovalExpiry: null, authorizationExpiry: null },
          authorizedAmount: amount,
          capturedAmount: name === "PaymentCharged" ? amount : 0n,
          feeAmount: name === "PaymentCharged" ? big(p.feeAmount) : 0n,
          voided: false, reclaimed: false, refundedAmount: 0n,
          lastEventTime: r.block_timestamp ?? null,
          txHash: r.transaction_hash ?? null,
        });
      }
    } else {
      const pm = payments.get(hash);
      if (!pm) continue; // lifecycle event whose authorization predates the window
      pm.lastEventTime = r.block_timestamp ?? pm.lastEventTime;
      if (name === "PaymentCaptured") { pm.capturedAmount += big(p.amount); pm.feeAmount += big(p.feeAmount); }
      else if (name === "PaymentVoided") pm.voided = true;
      else if (name === "PaymentReclaimed") pm.reclaimed = true;
      else if (name === "PaymentRefunded") pm.refundedAmount += big(p.amount);
    }
  }
  return payments;
}

function statusOf(p: Payment): string {
  if (p.voided) return "voided";
  if (p.reclaimed) return "reclaimed";
  if (p.refundedAmount > 0n) return "refunded";
  if (p.capturedAmount >= p.authorizedAmount && p.capturedAmount > 0n) return "captured";
  if (p.capturedAmount > 0n) return "partially_captured";
  if (p.info.authorizationExpiry && Date.now() / 1000 > p.info.authorizationExpiry) return "expired_reclaimable";
  return "in_escrow";
}

const fmtAmount = (v: bigint, token: string | null) =>
  token && token.toLowerCase() === USDC ? `$${(Number(v) / 1e6).toFixed(2)}` : v.toString();

function serialize(p: Payment) {
  const status = statusOf(p);
  return {
    payment: p.hash,
    status, // charged|captured|partially_captured|in_escrow|expired_reclaimable|voided|reclaimed|refunded
    operator: p.info.operator,
    payer: p.info.payer,
    receiver: p.info.receiver,
    token: p.info.token,
    authorized: fmtAmount(p.authorizedAmount, p.info.token),
    captured: fmtAmount(p.capturedAmount, p.info.token),
    fee: fmtAmount(p.feeAmount, p.info.token),
    ...(p.refundedAmount > 0n ? { refunded: fmtAmount(p.refundedAmount, p.info.token) } : {}),
    authorizationExpiry: p.info.authorizationExpiry ? new Date(p.info.authorizationExpiry * 1000).toISOString() : null,
    firstSeen: p.time,
    lastEvent: p.lastEventTime,
    txHash: p.txHash,
  };
}

// ---- 1. Commerce Escrow Status — reconcile auth/capture payments ----

export async function commerceEscrow(params: Record<string, string>) {
  const payment = (params.payment || params.hash || "").trim().toLowerCase();
  const payer = (params.payer || "").trim();
  const receiver = (params.receiver || params.merchant || "").trim();
  const operator = (params.operator || "").trim();

  const { rows, truncated } = await fetchEscrowEvents(90);
  const all = [...buildPayments(rows).values()];

  let filtered = all;
  let mode = "network";
  if (/^0x[0-9a-f]{64}$/.test(payment)) { filtered = all.filter((p) => p.hash === payment); mode = "payment"; }
  else if (validAddr(payer)) { const a = getAddress(payer); filtered = all.filter((p) => p.info.payer === a); mode = "payer"; }
  else if (validAddr(receiver)) { const a = getAddress(receiver); filtered = all.filter((p) => p.info.receiver === a); mode = "receiver"; }
  else if (validAddr(operator)) { const a = getAddress(operator); filtered = all.filter((p) => p.info.operator === a); mode = "operator"; }

  const out = filtered.sort((a, b) => (b.time ?? "").localeCompare(a.time ?? "")).map(serialize);
  const inEscrow = out.filter((x) => x.status === "in_escrow" || x.status === "expired_reclaimable");
  const reclaimable = out.filter((x) => x.status === "expired_reclaimable");

  return finish({
    escrow: AUTH_CAPTURE_ESCROW,
    mode, // payment | payer | receiver | operator | network
    windowDays: 90,
    ...(truncated ? { truncated: true } : {}),
    paymentCount: out.length,
    inEscrowCount: inEscrow.length,
    reclaimableCount: reclaimable.length,
    payments: out.slice(0, 50),
    verdict: mode === "payment" && out.length === 0
      ? "not_found"
      : reclaimable.length
        ? "reclaimable_funds"
        : inEscrow.length
          ? "funds_in_escrow"
          : out.length
            ? "settled"
            : "no_activity",
    recommendation: reclaimable.length
      ? `${reclaimable.length} payment(s) passed their authorization expiry without being captured — the payer can reclaim those escrowed funds now (reclaim()). Merchants: your operator missed the capture window.`
      : inEscrow.length
        ? `${inEscrow.length} payment(s) currently held in escrow awaiting capture or void. Watch authorizationExpiry — funds become payer-reclaimable after it.`
        : out.length
          ? "All matched payments have completed their lifecycle (captured, charged, voided, reclaimed or refunded)."
          : "No Commerce Payments activity matched in the 90-day window.",
    note: "Reconciles Base's Commerce Payments escrow (AuthCaptureEscrow auth/capture flows): status per payment — in escrow, captured, charged, voided, payer-reclaimable (capture window missed), refunded — with amounts and fees. Filter by payment= (infoHash), payer=, receiver= or operator=; no filter = network feed. Not financial advice.",
  });
}

// ---- 2. Payment Operator Audit — should you trust this operator? ----

export async function commerceOperatorAudit(params: Record<string, string>) {
  const operator = (params.operator || params.address || "").trim();
  if (!validAddr(operator)) throw new Error("Provide a valid 0x… operator address (operator=)");
  const op = getAddress(operator);

  const { rows, truncated } = await fetchEscrowEvents(90);
  const mine = [...buildPayments(rows).values()].filter((p) => p.info.operator === op);

  const big0 = { auth: 0n, cap: 0n, fee: 0n, refund: 0n };
  const sums = mine.reduce((a, p) => ({ auth: a.auth + p.authorizedAmount, cap: a.cap + p.capturedAmount, fee: a.fee + p.feeAmount, refund: a.refund + p.refundedAmount }), big0);
  const statuses = mine.map(statusOf);
  const count = (s: string) => statuses.filter((x) => x === s).length;
  const voided = count("voided");
  const reclaimed = count("reclaimed") + count("expired_reclaimable");
  const completed = count("captured") + count("charged") + count("partially_captured");
  const payers = new Set(mine.map((p) => p.info.payer).filter(Boolean));
  const receivers = new Set(mine.map((p) => p.info.receiver).filter(Boolean));
  const tokens = new Set(mine.map((p) => p.info.token).filter(Boolean));
  const usdcOnly = tokens.size === 1 && [...tokens][0]?.toLowerCase() === USDC;
  const denom = mine.length || 1;
  const reclaimRate = +(100 * reclaimed / denom).toFixed(1);
  const captureRate = +(100 * completed / denom).toFixed(1);

  const verdict = mine.length === 0
    ? "no_activity"
    : reclaimRate >= 25
      ? "sloppy_operator"
      : captureRate >= 60
        ? "healthy_operator"
        : "mixed";

  return finish({
    operator: op,
    escrow: AUTH_CAPTURE_ESCROW,
    windowDays: 90,
    ...(truncated ? { truncated: true } : {}),
    paymentCount: mine.length,
    distinctPayers: payers.size,
    distinctReceivers: receivers.size,
    tokens: [...tokens],
    totalAuthorized: usdcOnly ? fmtAmount(sums.auth, USDC) : sums.auth.toString(),
    totalCaptured: usdcOnly ? fmtAmount(sums.cap, USDC) : sums.cap.toString(),
    totalFees: usdcOnly ? fmtAmount(sums.fee, USDC) : sums.fee.toString(),
    totalRefunded: usdcOnly ? fmtAmount(sums.refund, USDC) : sums.refund.toString(),
    statusBreakdown: { completed, inEscrow: count("in_escrow"), voided, reclaimable: reclaimed, refunded: count("refunded") },
    captureRatePct: captureRate,
    reclaimRatePct: reclaimRate,
    verdict, // healthy_operator | mixed | sloppy_operator | no_activity
    recommendation: verdict === "no_activity"
      ? "No Commerce Payments activity for this operator in 90 days — it has processed nothing recently; treat trust claims accordingly."
      : verdict === "sloppy_operator"
        ? `⚠️ ${reclaimRate}% of this operator's payments ended payer-reclaimable (capture window missed) — merchants relying on it risk uncollected payments. Review before integrating.`
        : verdict === "healthy_operator"
          ? `Healthy operator: ${captureRate}% of ${mine.length} payment(s) completed to capture across ${payers.size} payer(s) and ${receivers.size} merchant(s).`
          : "Mixed record — payments flow, but a meaningful share end voided or unclaimed. Sample individual payments (commerce-escrow) before trusting at volume.",
    note: "Trust audit of a Commerce Payments OPERATOR (the party driving auth/capture flows on Base's AuthCaptureEscrow): volumes, fees taken, capture-vs-reclaim record and counterparty breadth over 90 days. The reference an agent or merchant should pull before letting an operator hold their payment flow. Not financial advice.",
  });
}
