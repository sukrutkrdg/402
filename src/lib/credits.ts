/**
 * Prepaid credits (P3) — buy a balance once, spend it per-call without settling
 * x402 every time.
 *
 * WHY: every paid call today costs the buyer a signed USDC settlement (a few
 * seconds of latency + a facilitator round trip). A trading agent that fires 200
 * checks a minute wants to pay ONCE and then draw down. So we sell a prepaid pack
 * (one x402 settlement) and hand back a secret bearer token; later calls present
 * that token and we debit an integer-cent balance in KV — no per-call settlement.
 *
 * SECURITY MODEL: the credit token is a bearer capability (like a prepaid API
 * key). Whoever holds `ck_…` can spend the balance, so it's returned exactly ONCE
 * at purchase and only its hash is stored — a KV leak never reveals a spendable
 * token. Revenue is collected UP FRONT at purchase via real x402 settlement; the
 * debit path moves no money, it only draws down what was already paid. Balance is
 * integer cents (no float drift) and debited with atomic DECRBY (+refund on
 * overdraw) so concurrent calls can't double-spend. Credits require KV — with no
 * durable store the ledger fails closed (no balance = normal x402).
 */

import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { kvConfigured, kvGetNumber, kvSet, kvDecrBy, kvIncrBy, kvDel } from "./kv";

/** Prepaid packs: pay `usd`, receive `credits` (a small bonus rewards prepaying). */
export const CREDIT_TIERS: Record<string, { usd: number; credits: number }> = {
  "0.25": { usd: 0.25, credits: 25 }, // $0.25 → 25¢ starter — lowest-commitment taste of the paid tier
  "1": { usd: 1, credits: 100 }, //  $1.00 → 100¢ (no bonus)
  "5": { usd: 5, credits: 550 }, //  $5.00 → 550¢ (+10%)
  "20": { usd: 20, credits: 2400 }, // $20.00 → 2400¢ (+20%)
};
export const DEFAULT_TIER = "5";

// 180-day balance TTL — long enough to feel like money in the bank, short enough
// that abandoned balances don't accrue in KV forever.
const BALANCE_TTL = 60 * 60 * 24 * 180;

/** The x402 price string for a tier, used by the route to set the challenge amount. */
export function tierPrice(tier: string): string {
  const t = CREDIT_TIERS[tier] ?? CREDIT_TIERS[DEFAULT_TIER];
  return `$${t.usd.toFixed(2)}`;
}

const keyFor = (token: string) => `credit:${createHash("sha256").update(token).digest("hex").slice(0, 24)}`;

/**
 * Handler for the `buy-credits` service. Runs only AFTER x402 payment is verified
 * (the service is noFreeTier, so it never serves free), so minting a balance here
 * means the buyer has paid. Returns the bearer token exactly once.
 */
export async function buyCredits(params: Record<string, string>) {
  if (!kvConfigured()) throw new Error("Credits unavailable: durable storage not configured");
  const tier = (params.tier || DEFAULT_TIER).trim();
  const pack = CREDIT_TIERS[tier];
  if (!pack) throw new Error(`Invalid tier — choose one of: ${Object.keys(CREDIT_TIERS).join(", ")}`);

  const token = `ck_${randomBytes(18).toString("hex")}`;
  const set = await kvIncrBy(keyFor(token), pack.credits); // create/topup atomically
  // A null here means the ledger write did NOT happen (KV unreachable). Throwing
  // makes the response ≥400 so withX402 never settles — the one path that mints
  // money must fail CLOSED, or the customer pays for a token with no balance.
  if (set === null) throw new Error("Credits unavailable: ledger write failed — payment not settled, retry shortly");
  // Refresh the TTL on the (new) balance key.
  await kvSet(keyFor(token), String(set), BALANCE_TTL);

  return {
    creditToken: token,
    balanceUsd: +(set / 100).toFixed(2),
    paidUsd: pack.usd,
    creditedUsd: +(pack.credits / 100).toFixed(2),
    bonusUsd: +((pack.credits - pack.usd * 100) / 100).toFixed(2),
    howToSpend:
      "Send this token as the `x-credit-token` header on any paid service call. Each call debits its price from your balance — no x402 settlement, no per-call signature. The response returns your remaining balance in `x-credit-balance` (cents).",
    security: "This token is a bearer key — anyone holding it can spend the balance. Store it secretly; it is shown only once and cannot be recovered.",
    expiresInDays: 180,
    note: "Prepaid credits. Buy more anytime (re-buy tops up the same flow). Not refundable to chain.",
  };
}

export interface DebitResult {
  ok: boolean;
  /** Remaining balance in cents after a successful debit. */
  remaining: number;
  reason?: "no_kv" | "bad_token" | "insufficient";
  balance?: number; // current balance in cents (on failure, for the 402 hint)
}

/**
 * Atomically debit `priceCents` from a credit token's balance. Returns ok=false
 * (with the current balance) when the token is unknown or underfunded, having
 * refunded any speculative decrement so the balance is never left corrupted.
 */
export async function debitCredit(token: string, priceCents: number): Promise<DebitResult> {
  if (!kvConfigured()) return { ok: false, remaining: 0, reason: "no_kv" };
  const t = (token || "").trim();
  if (!/^ck_[0-9a-f]{36}$/.test(t)) return { ok: false, remaining: 0, reason: "bad_token" };
  const key = keyFor(t);

  const after = await kvDecrBy(key, priceCents);
  if (after === null) return { ok: false, remaining: 0, reason: "no_kv" };
  if (after < 0) {
    // Overdraw (or unknown token, which DECRBY treats as 0) → put it back. When
    // the restored balance is exactly 0 the key was almost certainly minted by
    // this very probe (unknown token) — delete it so bad-token spam can't grow
    // KV with permanent zero-value keys.
    await kvIncrBy(key, priceCents);
    const balance = after + priceCents;
    if (balance === 0) await kvDel(key);
    return { ok: false, remaining: 0, reason: "insufficient", balance: Math.max(0, balance) };
  }
  return { ok: true, remaining: after };
}

/**
 * Return `cents` to a token's balance — used to undo a debit when the handler
 * fails AFTER we've already charged (debit-first ordering avoids the double-spend
 * race, so the refund is the compensating action on the error path).
 */
export async function refundCredit(token: string, cents: number): Promise<void> {
  const t = (token || "").trim();
  if (!kvConfigured() || !/^ck_[0-9a-f]{36}$/.test(t)) return;
  await kvIncrBy(keyFor(t), cents);
}

/** Read-only balance for a token (cents). 0 when unknown/expired/no-KV. */
export async function creditBalance(token: string): Promise<number> {
  const t = (token || "").trim();
  if (!kvConfigured() || !/^ck_[0-9a-f]{36}$/.test(t)) return 0;
  return await kvGetNumber(keyFor(t));
}
