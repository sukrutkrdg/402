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
import {
  kvConfigured,
  kvGetNumber,
  kvSet,
  kvDecrBy,
  kvIncrBy,
  kvDel,
  kvSAdd,
  kvSRem,
  kvSMembers,
  kvExpire,
  kvPipeline,
} from "./kv";

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
  const tier = (params.tier || DEFAULT_TIER).trim();
  const pack = CREDIT_TIERS[tier];
  if (!pack) throw new Error(`Invalid tier — choose one of: ${Object.keys(CREDIT_TIERS).join(", ")}`);
  return mintCredits(pack.credits, pack.usd);
}

/**
 * Mint a fresh credit token carrying `credits` cents. The single place that can
 * create spendable balance, so every purchase rail funnels through here.
 *
 * Callers MUST have confirmed payment first — this function does not check.
 */
export async function mintCredits(credits: number, paidUsd: number) {
  if (!kvConfigured()) throw new Error("Credits unavailable: durable storage not configured");
  if (!Number.isInteger(credits) || credits <= 0) throw new Error("Invalid credit amount");

  const token = `ck_${randomBytes(18).toString("hex")}`;
  const set = await kvIncrBy(keyFor(token), credits); // create/topup atomically
  // A null here means the ledger write did NOT happen (KV unreachable). Throwing
  // makes the response ≥400 so withX402 never settles — the one path that mints
  // money must fail CLOSED, or the customer pays for a token with no balance.
  if (set === null) throw new Error("Credits unavailable: ledger write failed — payment not settled, retry shortly");
  // Refresh the TTL on the (new) balance key.
  await kvSet(keyFor(token), String(set), BALANCE_TTL);

  return {
    creditToken: token,
    balanceUsd: +(set / 100).toFixed(2),
    paidUsd,
    creditedUsd: +(credits / 100).toFixed(2),
    bonusUsd: +((credits - paidUsd * 100) / 100).toFixed(2),
    howToSpend:
      "Send this token as the `x-credit-token` header on any paid service call. Each call debits its price from your balance — no x402 settlement, no per-call signature. The response returns your remaining balance in `x-credit-balance` (cents).",
    security:
      "This token is a bearer key — anyone holding it can spend the balance. Store it secretly; it is shown only once. If you lose it, the balance can be moved to a fresh token by signing a message from the wallet that paid for it (POST /api/credits/recover) — the lost token stops working at that point. The token itself is never recoverable, because only its hash is stored.",
    expiresInDays: 180,
    checkBalance:
      "GET /api/credits/balance with the same `x-credit-token` header — reads the balance without spending any of it.",
    note: "Prepaid credits. Buying again mints a SEPARATE token with its own balance — it does not top up this one; recovery from the paying wallet merges them into one. Not refundable to chain.",
  };
}

const ownerKey = (addr: string) => `credit:owner:${addr.toLowerCase()}`;

/**
 * Remember which wallet paid for a token, so the balance can be recovered if the
 * one-time token is lost.
 *
 * Only the token's HASH is indexed — the plaintext is still never stored. That
 * means recovery cannot return the original token; it re-issues a new one and
 * moves the balance, which is the same thing a customer wants and is strictly
 * safer (a lost-but-leaked token stops working the moment the owner recovers).
 */
export async function linkCreditOwner(owner: string, token: string): Promise<void> {
  if (!kvConfigured() || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return;
  await kvSAdd(ownerKey(owner), keyFor(token));
  // Match the balance TTL so the index can't outlive what it points at.
  await kvExpire(ownerKey(owner), BALANCE_TTL);
}

export interface RecoverResult {
  recoveredCents: number;
  tokensMerged: number;
  minted?: Awaited<ReturnType<typeof mintCredits>>;
}

/**
 * Re-issue a single fresh token carrying every remaining cent this wallet has
 * bought, and invalidate the old ones.
 *
 * Callers MUST have verified that the requester controls `owner` (a signature)
 * before calling — this function does not authenticate.
 */
export async function recoverCredits(owner: string): Promise<RecoverResult> {
  if (!kvConfigured()) throw new Error("Credits unavailable: durable storage not configured");
  const keys = await kvSMembers(ownerKey(owner));
  let total = 0;
  let merged = 0;

  for (const key of keys) {
    const balance = await kvGetNumber(key);
    if (balance <= 0) {
      await kvSRem(ownerKey(owner), key); // spent or expired — stop tracking it
      continue;
    }
    // Drain the old key so the previous token can't keep spending what we're
    // about to re-issue. A concurrent call may have taken some of it between the
    // read and the decrement, which shows up as a negative remainder — put that
    // part back and only move what was actually ours to move.
    const after = await kvDecrBy(key, balance);
    if (after === null) throw new Error("Credits unavailable: ledger read failed — nothing was changed");
    let moved = balance;
    if (after < 0) {
      await kvIncrBy(key, -after);
      moved = balance + after;
    }
    if (moved <= 0) continue;
    total += moved;
    merged++;
    if ((await kvGetNumber(key)) <= 0) await kvDel(key);
    await kvSRem(ownerKey(owner), key);
  }

  if (total <= 0) return { recoveredCents: 0, tokensMerged: 0 };

  const minted = await mintCredits(total, total / 100);
  await linkCreditOwner(owner, minted.creditToken);
  return { recoveredCents: total, tokensMerged: merged, minted };
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
    // KV with permanent zero-value keys. (A rare 3-way concurrent-overdraw race can
    // resurrect a tiny key via a refund landing after this delete; left as-is
    // deliberately — it's customer-favorable, ≤ one call's price, and any atomic
    // fix would risk the far worse inverse: zeroing a legitimately-restored balance.)
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
  // The refund undoes a charge for a call that FAILED, so silently losing it (a
  // transient KV blip returning null) would leave the customer paying for nothing.
  // Best-effort retry once after a short delay before giving up.
  if ((await kvIncrBy(keyFor(t), cents)) === null) {
    await new Promise((r) => setTimeout(r, 400));
    await kvIncrBy(keyFor(t), cents);
  }
}

/** Read-only balance for a token (cents). 0 when unknown/expired/no-KV. */
export async function creditBalance(token: string): Promise<number> {
  const t = (token || "").trim();
  if (!kvConfigured() || !/^ck_[0-9a-f]{36}$/.test(t)) return 0;
  return await kvGetNumber(keyFor(t));
}

/**
 * Balance plus how long it has left — what a prepaid customer needs to see
 * without spending a call to find out. The balance TTL is the expiry, so it is
 * read straight off the key rather than tracked separately.
 */
export async function creditStatus(token: string): Promise<{ cents: number; expiresInDays: number | null }> {
  const t = (token || "").trim();
  if (!kvConfigured() || !/^ck_[0-9a-f]{36}$/.test(t)) return { cents: 0, expiresInDays: null };
  const key = keyFor(t);
  const cents = await kvGetNumber(key);
  if (cents <= 0) return { cents: 0, expiresInDays: null };
  const res = await kvPipeline([["ttl", key]]);
  const ttl = Number((res?.[0] as { result?: unknown } | undefined)?.result ?? res?.[0] ?? -1);
  return { cents, expiresInDays: Number.isFinite(ttl) && ttl > 0 ? Math.ceil(ttl / 86400) : null };
}
