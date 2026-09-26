/**
 * NEAR swap — a live NEAR Intents swap an agent can execute: a binding 1Click
 * quote with a deposit address. The agent sends `amountIn` of the origin asset
 * to that address on the origin chain before the deadline; 1Click delivers the
 * destination asset to `recipient`, or refunds to `refundTo`. Funds never pass
 * through us — the deposit address belongs to 1Click.
 *
 * Distribution fee: when NEAR_INTENTS_FEE_RECIPIENT and NEAR_INTENTS_FEE_BPS
 * are set, the quote carries 1Click `appFees` — a share of each swap, credited
 * to that account inside NEAR Intents. Off when unset.
 *
 * Buying a NEAR token: the destination is run through near-token-safety first,
 * and a STOP token is refused (not charged) unless force=1.
 *
 * near-swap-status reads the progress of a swap by its deposit address.
 */

import "server-only";
import { intentsTokens, parseUnits, formatUnits } from "./near-rpc";
import { resolveAsset } from "./near-swap-quote";
import { nearTokenSafety } from "./near-token-safety";

const ONECLICK = "https://1click.chaindefuser.com";
const DEADLINE_MS = 60 * 60_000;

/** The distribution fee, or null when off. Capped at 1% so a typo cannot overcharge. */
export function swapFee(): { recipient: string; bps: number } | null {
  const recipient = (process.env.NEAR_INTENTS_FEE_RECIPIENT || "").trim();
  const bps = Number(process.env.NEAR_INTENTS_FEE_BPS || 0);
  if (!recipient || !Number.isInteger(bps) || bps <= 0) return null;
  return { recipient, bps: Math.min(bps, 100) };
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (process.env.NEAR_INTENTS_JWT) h.authorization = `Bearer ${process.env.NEAR_INTENTS_JWT}`;
  return h;
}

async function oneClick<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T & { message?: string } }> {
  let res: Response;
  try {
    res = await fetch(`${ONECLICK}${path}`, { ...init, headers: headers(), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error("NEAR Intents unreachable — not charged, retry shortly");
  }
  const text = await res.text();
  let body = {} as T & { message?: string };
  try {
    body = JSON.parse(text);
  } catch {
    body = { message: text.slice(0, 200) } as T & { message?: string };
  }
  if (res.status >= 500) throw new Error(`NEAR Intents unavailable (${res.status}) — not charged, retry shortly`);
  return { status: res.status, body };
}

const ADDRESS_RE = /^[A-Za-z0-9._:\-]{2,128}$/;

export async function nearSwap(params: Record<string, string>) {
  const recipient = (params.recipient || "").trim();
  const refundTo = (params.refundTo || params.refund_to || "").trim();
  if (!ADDRESS_RE.test(recipient)) throw new Error("recipient is required: the address on the destination chain that receives the output");
  if (!ADDRESS_RE.test(refundTo)) throw new Error("refundTo is required: your address on the origin chain, refunded if the swap cannot complete");
  const slippage = params.slippage ? Number(params.slippage) : 100;
  if (!Number.isInteger(slippage) || slippage < 1 || slippage > 1000) throw new Error("slippage is in basis points: 1–1000 (default 100 = 1%)");

  const tokens = await intentsTokens();
  if (!tokens) throw new Error("NEAR Intents token list unavailable — not charged, retry shortly");
  const from = resolveAsset(tokens, params.from);
  const to = resolveAsset(tokens, params.to);
  if ("error" in from) throw new Error(`from: ${from.error === "missing" ? "required (e.g. USDC, NEAR, USDC@base)" : from.error}`);
  if ("error" in to) throw new Error(`to: ${to.error === "missing" ? "required (e.g. NEAR, usdt.tether-token.near)" : to.error}`);
  if (from.assetId === to.assetId) throw new Error("from and to are the same asset");
  const amount = parseUnits(params.amount || "", from.decimals);
  if (!amount) throw new Error(`amount must be a positive number of ${from.symbol}, e.g. 100`);

  // Buying a NEAR token: check who controls it before handing out a deposit address.
  let safety: { verdict: string; reasons: string[] } | null = null;
  if (to.blockchain === "near" && to.contractAddress && to.contractAddress !== "wrap.near") {
    const s = await nearTokenSafety({ token: to.contractAddress });
    safety = { verdict: s.verdict, reasons: s.reasons };
    if (s.verdict === "STOP" && params.force !== "1") {
      throw new Error(`Refused: ${to.contractAddress} fails near-token-safety (STOP: ${s.reasons.join(" ")}) — not charged. Pass force=1 to quote anyway.`);
    }
  }

  const fee = swapFee();
  const deadline = new Date(Date.now() + DEADLINE_MS).toISOString();
  const { status, body } = await oneClick<{
    correlationId?: string;
    quote?: {
      depositAddress?: string;
      depositMemo?: string;
      amountIn: string;
      amountInFormatted: string;
      amountInUsd?: string;
      amountOut: string;
      amountOutFormatted: string;
      amountOutUsd?: string;
      minAmountOut: string;
      deadline?: string;
      timeWhenInactive?: string;
      timeEstimate?: number;
    };
  }>("/v0/quote", {
    method: "POST",
    body: JSON.stringify({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: slippage,
      originAsset: from.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: to.assetId,
      amount,
      refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline,
      referral: "402comtr",
      quoteWaitingTimeMs: 3000,
      ...(fee ? { appFees: [{ recipient: fee.recipient, fee: fee.bps }] } : {}),
    }),
  });
  const q = body.quote;
  if (status >= 400 || !q?.depositAddress) {
    throw new Error(`No swap: ${body.message || `1Click answered ${status}`} — not charged`);
  }

  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  return {
    chain: "near-intents" as const,
    checkedAt: new Date().toISOString(),
    from: { assetId: from.assetId, symbol: from.symbol, chain: from.blockchain },
    to: { assetId: to.assetId, symbol: to.symbol, chain: to.blockchain },
    deposit: {
      address: q.depositAddress,
      memo: q.depositMemo ?? null,
      chain: from.blockchain,
      asset: from.symbol,
      amount: q.amountInFormatted,
      amountBaseUnits: q.amountIn,
      sendBefore: q.deadline ?? deadline,
    },
    amountInUsd: num(q.amountInUsd),
    amountOut: q.amountOutFormatted,
    amountOutUsd: num(q.amountOutUsd),
    minAmountOut: formatUnits(String(q.minAmountOut), to.decimals),
    recipient,
    refundTo,
    timeEstimateSec: num(q.timeEstimate),
    correlationId: body.correlationId ?? null,
    distributionFeeBps: fee?.bps ?? 0,
    tokenSafety: safety,
    next: [
      `Send exactly ${q.amountInFormatted} ${from.symbol} on ${from.blockchain} to ${q.depositAddress}${q.depositMemo ? ` with memo ${q.depositMemo}` : ""} before ${q.deadline ?? deadline}.`,
      `Track it: GET /api/x402/near-swap-status?depositAddress=${q.depositAddress}`,
      "If the deposit is late, short, or the price moves beyond slippage, 1Click refunds to refundTo.",
    ],
  };
}

export async function nearSwapStatus(params: Record<string, string>) {
  const depositAddress = (params.depositAddress || params.deposit_address || "").trim();
  if (!ADDRESS_RE.test(depositAddress)) throw new Error("depositAddress is required: the address near-swap returned");
  const memo = (params.depositMemo || "").trim();
  const qs = `depositAddress=${encodeURIComponent(depositAddress)}${memo ? `&depositMemo=${encodeURIComponent(memo)}` : ""}`;
  const { status, body } = await oneClick<{
    status?: string;
    updatedAt?: string;
    swapDetails?: {
      amountInFormatted?: string;
      amountOutFormatted?: string;
      amountOutUsd?: string;
      refundedAmountFormatted?: string;
      refundReason?: string;
      originChainTxHashes?: { hash: string; explorerUrl?: string }[];
      destinationChainTxHashes?: { hash: string; explorerUrl?: string }[];
    };
  }>(`/v0/status?${qs}`);
  if (status === 404) {
    return {
      chain: "near-intents" as const,
      depositAddress,
      status: "NOT_FOUND",
      meaning: "1Click knows no swap with this deposit address — check it; a quote just made can take a moment to appear.",
      done: false,
    };
  }
  if (status >= 400 || !body.status) throw new Error(`Status unavailable: ${body.message || status} — not charged`);
  const d = body.swapDetails ?? {};
  const meaning: Record<string, string> = {
    PENDING_DEPOSIT: "Waiting for your deposit.",
    KNOWN_DEPOSIT_TX: "Deposit seen on the origin chain, waiting for confirmations.",
    INCOMPLETE_DEPOSIT: "Deposit is less than required; top it up before the deadline or it is refunded.",
    PROCESSING: "Deposit received; the swap is executing.",
    SUCCESS: "Done: the output was delivered to the recipient.",
    REFUNDED: "Refunded to refundTo.",
    FAILED: "Failed; see refund details.",
  };
  return {
    chain: "near-intents" as const,
    depositAddress,
    status: body.status,
    meaning: meaning[body.status] ?? null,
    done: ["SUCCESS", "REFUNDED", "FAILED"].includes(body.status),
    updatedAt: body.updatedAt ?? null,
    amountIn: d.amountInFormatted ?? null,
    amountOut: d.amountOutFormatted ?? null,
    amountOutUsd: d.amountOutUsd ? Number(d.amountOutUsd) : null,
    refunded: d.refundedAmountFormatted ?? null,
    refundReason: d.refundReason ?? null,
    originTxs: (d.originChainTxHashes ?? []).map((t) => t.explorerUrl || t.hash),
    destinationTxs: (d.destinationChainTxHashes ?? []).map((t) => t.explorerUrl || t.hash),
  };
}
