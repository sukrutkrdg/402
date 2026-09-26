/**
 * The books of near-swap: what we earn when agents swap through NEAR Intents.
 *
 * Three numbers, from three places, because they answer different questions:
 *   - quotes      — deposit addresses handed out (KV, counted by near-swap)
 *   - completed   — of the recent ones, which 1Click reports as SUCCESS, and
 *                   their volume (asked of 1Click, cached by the caller)
 *   - earned      — the distribution fee actually credited to the fee account
 *                   inside NEAR Intents (read from intents.near on-chain). The
 *                   only number that is money; the others explain it.
 *
 * The fee: NEAR_INTENTS_FEE_BPS is charged on the swap's input; 1Click keeps
 * half, the fee account gets half (verified live: 20 bps on 5 USDC credited
 * 0.005 USDC).
 */

import "server-only";
import { kvIncrBy, kvGetNumber, kvLPush, kvLRange } from "./kv";
import { viewCall, intentsTokens, formatUnits } from "./near-rpc";
import { swapFee } from "./near-swap";

export const SWAP_LEDGER = {
  quotes: "near:swap:quotes",
  quotedCents: "near:swap:quotedCents",
  recent: "near:swap:recent",
};

interface RecentQuote {
  t: string;
  dep: string;
  memo?: string | null;
  from: string;
  to: string;
  usd: number | null;
}

/** Called by near-swap after a deposit address is handed out. Best-effort. */
export async function recordSwapQuote(q: RecentQuote): Promise<void> {
  await Promise.all([
    kvIncrBy(SWAP_LEDGER.quotes, 1),
    kvIncrBy(SWAP_LEDGER.quotedCents, Math.round((q.usd ?? 0) * 100)),
    kvLPush(SWAP_LEDGER.recent, JSON.stringify(q), 50),
  ]).catch(() => {});
}

async function statusOf(dep: string, memo?: string | null): Promise<{ status: string; inUsd: number | null }> {
  try {
    const qs = `depositAddress=${encodeURIComponent(dep)}${memo ? `&depositMemo=${encodeURIComponent(memo)}` : ""}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (process.env.NEAR_INTENTS_JWT) headers.authorization = `Bearer ${process.env.NEAR_INTENTS_JWT}`;
    const res = await fetch(`https://1click.chaindefuser.com/v0/status?${qs}`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { status: res.status === 404 ? "NOT_FOUND" : "UNKNOWN", inUsd: null };
    const j = (await res.json()) as { status?: string; swapDetails?: { amountInUsd?: string } };
    return { status: j.status ?? "UNKNOWN", inUsd: j.swapDetails?.amountInUsd ? Number(j.swapDetails.amountInUsd) : null };
  } catch {
    return { status: "UNKNOWN", inUsd: null };
  }
}

/** What the fee account holds inside NEAR Intents, priced. Null when the fee is off or unreadable. */
async function earned(recipient: string) {
  const owned = await viewCall<{ token_id: string }[]>("intents.near", "mt_tokens_for_owner", { account_id: recipient });
  if (!Array.isArray(owned)) return null;
  const tokens = await intentsTokens();
  const balances = await Promise.all(
    owned.slice(0, 20).map(async ({ token_id }) => {
      const raw = await viewCall<string>("intents.near", "mt_balance_of", { account_id: recipient, token_id });
      const t = tokens?.find((x) => x.assetId === token_id);
      const amount = typeof raw === "string" && /^\d+$/.test(raw) && t ? formatUnits(raw, t.decimals) : null;
      const usd = amount !== null && t?.price ? +(Number(amount) * t.price).toFixed(4) : null;
      return { token: token_id, symbol: t?.symbol ?? token_id, amount: amount ?? raw ?? "?", usd };
    }),
  );
  return { balances, totalUsd: +balances.reduce((s, b) => s + (b.usd ?? 0), 0).toFixed(4) };
}

export async function nearSwapBook() {
  const fee = swapFee();
  const [quotes, quotedCents, rawRecent] = await Promise.all([
    kvGetNumber(SWAP_LEDGER.quotes),
    kvGetNumber(SWAP_LEDGER.quotedCents),
    kvLRange(SWAP_LEDGER.recent, 0, 19),
  ]);
  const recentQuotes = rawRecent
    .map((s) => {
      try {
        return JSON.parse(s) as RecentQuote;
      } catch {
        return null;
      }
    })
    .filter((x): x is RecentQuote => Boolean(x));
  const statuses = await Promise.all(recentQuotes.map((q) => statusOf(q.dep, q.memo)));
  const recent = recentQuotes.map((q, i) => ({ ...q, status: statuses[i].status, doneUsd: statuses[i].status === "SUCCESS" ? statuses[i].inUsd ?? q.usd : null }));
  const done = recent.filter((r) => r.status === "SUCCESS");
  const completedUsd = +done.reduce((s, r) => s + (r.doneUsd ?? 0), 0).toFixed(2);

  return {
    feeOn: Boolean(fee),
    feeBps: fee?.bps ?? 0,
    /** What the user pays, and what reaches the fee account (half; 1Click keeps the other half). */
    userPaysPct: fee ? fee.bps / 100 : 0,
    weKeepPct: fee ? fee.bps / 200 : 0,
    recipient: fee?.recipient ?? null,
    quotes,
    quotedUsd: +(quotedCents / 100).toFixed(2),
    completedRecent: done.length,
    completedRecentUsd: completedUsd,
    estFeeRecentUsd: fee ? +((completedUsd * fee.bps) / 20000).toFixed(4) : 0,
    earned: fee ? await earned(fee.recipient).catch(() => null) : null,
    recent: recent.slice(0, 10),
  };
}
