/**
 * NEAR swap quote — what would swapping A for B through NEAR Intents give back
 * right now? The NEAR counterpart of swap-route: an indicative, non-binding
 * quote (1Click `dry: true` — no deposit address, nothing to pay).
 *
 * Assets can be named the way an agent has them: a 1Click asset id
 * (`nep141:wrap.near`), a NEAR token account (`usdt.tether-token.near`), or a
 * symbol — `USDC` means USDC on NEAR, `USDC@base` pins another chain. The
 * resolved asset is always echoed back, so an ambiguous symbol is visible.
 *
 * Cost is reported as the USD value lost between what goes in and what comes
 * out (fees + price impact + spread), which is the number a trader acts on.
 */

import "server-only";
import { intentsTokens, parseUnits, formatUnits, type IntentsToken } from "./near-rpc";

const ONECLICK = "https://1click.chaindefuser.com";

/** Resolve how an agent names an asset to NEAR Intents' entry for it. */
export function resolveAsset(tokens: IntentsToken[], raw: string): IntentsToken | { error: string } {
  const q = (raw || "").trim();
  if (!q) return { error: "missing" };
  const byId = tokens.find((t) => t.assetId === q);
  if (byId) return byId;
  const lower = q.toLowerCase();
  const byAccount = tokens.find((t) => t.blockchain === "near" && (t.contractAddress ?? "").toLowerCase() === lower);
  if (byAccount) return byAccount;
  const [symRaw, chainRaw] = q.split("@");
  const sym = symRaw.toUpperCase() === "NEAR" ? "WNEAR" : symRaw.toUpperCase();
  const chain = (chainRaw || "near").toLowerCase();
  const matches = tokens.filter((t) => t.symbol.toUpperCase() === sym && t.blockchain === chain);
  if (matches.length === 0) {
    const elsewhere = [...new Set(tokens.filter((t) => t.symbol.toUpperCase() === sym).map((t) => t.blockchain))];
    return {
      error: elsewhere.length
        ? `${symRaw} is not routed on ${chain}; it is on: ${elsewhere.join(", ")} — write e.g. ${symRaw}@${elsewhere[0]}`
        : `${q} is not an asset NEAR Intents routes — pass a 1Click asset id (list: ${ONECLICK}/v0/tokens)`,
    };
  }
  // Several entries with one symbol on one chain (a native and a bridged USDT):
  // prefer the one with a live price, then the first listed.
  return matches.find((t) => typeof t.price === "number" && t.price > 0) ?? matches[0];
}

function describe(t: IntentsToken) {
  return { assetId: t.assetId, symbol: t.symbol, chain: t.blockchain, decimals: t.decimals, contract: t.contractAddress ?? null };
}

export interface QuoteResult {
  from: ReturnType<typeof describe>;
  to: ReturnType<typeof describe>;
  amountIn: string;
  amountInUsd: number | null;
  amountOut: string;
  /** amountOut in base units — what a follow-up quote (e.g. selling it back) takes as input. */
  amountOutRaw: string;
  amountOutUsd: number | null;
  minAmountOut: string;
  rate: number | null;
  costPct: number | null;
  timeEstimateSec: number | null;
}

/** One dry EXACT_INPUT quote. Shared by near-pre-trade-gate. Throws with a caller-readable message. */
export async function dryQuote(from: IntentsToken, to: IntentsToken, amountBase: string): Promise<QuoteResult> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (process.env.NEAR_INTENTS_JWT) headers.authorization = `Bearer ${process.env.NEAR_INTENTS_JWT}`;
  const res = await fetch(`${ONECLICK}/v0/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: from.assetId,
      destinationAsset: to.assetId,
      amount: amountBase,
      // A dry quote hands out no deposit address; these only have to be valid.
      depositType: "INTENTS",
      refundTo: "intents.near",
      refundType: "INTENTS",
      recipient: "intents.near",
      recipientType: "INTENTS",
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      referral: "402comtr",
      quoteWaitingTimeMs: 3000,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let j: { message?: string; quote?: Record<string, string | number | undefined> } = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !j.quote) {
    const msg = j.message || text.slice(0, 200) || res.statusText;
    // 4xx: the pair or amount (too small, no route) — the caller can change it.
    throw new Error(res.status >= 400 && res.status < 500 ? `No quote: ${msg}` : `NEAR Intents unavailable (${res.status}) — not charged, retry shortly`);
  }
  const q = j.quote;
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  const inUsd = num(q.amountInUsd);
  const outUsd = num(q.amountOutUsd);
  const inH = Number(q.amountInFormatted ?? formatUnits(String(q.amountIn), from.decimals));
  const outH = Number(q.amountOutFormatted ?? formatUnits(String(q.amountOut), to.decimals));
  return {
    from: describe(from),
    to: describe(to),
    amountIn: String(q.amountInFormatted ?? formatUnits(String(q.amountIn), from.decimals)),
    amountInUsd: inUsd,
    amountOut: String(q.amountOutFormatted ?? formatUnits(String(q.amountOut), to.decimals)),
    amountOutRaw: String(q.amountOut),
    amountOutUsd: outUsd,
    minAmountOut: formatUnits(String(q.minAmountOut ?? q.amountOut), to.decimals),
    rate: inH > 0 ? +(outH / inH).toPrecision(8) : null,
    costPct: inUsd && outUsd !== null && inUsd > 0 ? +(((inUsd - outUsd) / inUsd) * 100).toFixed(2) : null,
    timeEstimateSec: num(q.timeEstimate),
  };
}

export async function nearSwapQuote(params: Record<string, string>) {
  const tokens = await intentsTokens();
  if (!tokens) throw new Error("NEAR Intents token list unavailable — not charged, retry shortly");
  const from = resolveAsset(tokens, params.from);
  const to = resolveAsset(tokens, params.to);
  if ("error" in from) throw new Error(`from: ${from.error === "missing" ? "required (e.g. USDC, wrap.near or a 1Click asset id)" : from.error}`);
  if ("error" in to) throw new Error(`to: ${to.error === "missing" ? "required (e.g. NEAR, usdt.tether-token.near)" : to.error}`);
  if (from.assetId === to.assetId) throw new Error("from and to are the same asset");
  const base = parseUnits(params.amount || "", from.decimals);
  if (!base) throw new Error(`amount must be a positive number of ${from.symbol}, e.g. 100`);

  const q = await dryQuote(from, to, base);
  const notes: string[] = ["Indicative: a dry quote — nothing was reserved, and a live quote may differ."];
  if (!process.env.NEAR_INTENTS_JWT) notes.push("Quoted without a 1Click partner key, whose extra fee is included in amountOut.");
  if (q.costPct !== null && q.costPct > 3) notes.push(`High cost: ${q.costPct}% of the input's USD value is lost to fees and price impact.`);
  return { chain: "near-intents" as const, checkedAt: new Date().toISOString(), ...q, notes };
}
