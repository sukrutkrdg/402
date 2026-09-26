/**
 * Prepaid credits bought through NEAR Intents (1Click) — a way in for agents
 * that hold value on NEAR, or on any chain 1Click routes, but no USDC on Base.
 *
 * WHY A SEPARATE RAIL AND NOT A SECOND NETWORK IN `accepts[]`: see the Polygon
 * note in config.ts. Quoting two networks in one challenge made at least one
 * routing client skip us, and the extra network never saw a payment. So the
 * x402 challenge stays Base-only and untouched; NEAR arrives here instead, on
 * its own endpoint, and the money still lands as USDC on Base at `payTo`.
 *
 * FLOW
 *   1. createNearOrder: we ask 1Click for an EXACT_OUTPUT quote whose output is
 *      the pack price in Base USDC, paid to our own `payTo`. The agent gets a
 *      deposit address on its origin chain, an `orderId`, and an `orderSecret`.
 *   2. The agent sends the quoted `amountIn` of its asset to that address.
 *   3. checkNearOrder: we read the swap status from 1Click. On SUCCESS we mint
 *      the pack through `mintCredits` — exactly once per order — and return the
 *      `ck_…` token.
 *
 * SECURITY MODEL
 *   - The quote is built here, never by the caller: recipient, destination
 *     asset, amount and swap type are ours. The status response echoes the
 *     quote request back, and we refuse to mint unless that echo still matches
 *     what we stored — a deposit address from someone else's quote cannot be
 *     passed off as ours.
 *   - Only the hash of `orderSecret` is stored. Without it, knowing an orderId
 *     reveals nothing and mints nothing.
 *   - The minted token is stored ENCRYPTED under a key derived from the secret,
 *     so a repeated status read can hand the same token back (a dropped
 *     response does not lose a paid balance), while a KV leak still yields no
 *     spendable token. This is also the recovery story for this rail: the
 *     wallet-signature recovery in /api/credits/recover assumes an EVM payer,
 *     which a NEAR agent may not have.
 *   - Minting is guarded by SET NX on the order, so two concurrent polls that
 *     both see SUCCESS mint one balance.
 *
 * The whole rail is off unless ENABLE_NEAR_CREDITS=true.
 */

import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { kvConfigured, kvGet, kvSetChecked, kvSetNx, kvDel, kvIncrBy, kvGetNumber, kvLPush, kvLRange, kvSAdd, kvSRem, kvSMembers } from "./kv";
import { CREDIT_TIERS, mintCredits } from "./credits";
import { USDC_BASE, getConfig } from "./config";

export const ONECLICK_BASE = "https://1click.chaindefuser.com";

/**
 * 1Click's id for USDC on Base. Resolved from /v0/tokens at runtime; this is
 * only the fallback when that list cannot be read. Override with
 * NEAR_INTENTS_BASE_USDC_ASSET if 1Click ever renames it.
 */
export const BASE_USDC_ASSET_FALLBACK = `nep141:base-${USDC_BASE.toLowerCase()}.omft.near`;

/** Orders outlive the quote deadline so a slow swap can still be claimed. */
const ORDER_TTL = 60 * 60 * 24 * 14;
/** How long the agent has to deposit before 1Click refunds it. */
const DEADLINE_MS = 60 * 60 * 1000;
/** Slippage on the INPUT side (EXACT_OUTPUT); the excess is refunded by 1Click. */
const SLIPPAGE_BPS = 100;

const orderKey = (id: string) => `near:order:${id}`;
const mintLockKey = (id: string) => `near:order:${id}:mint`;

/** Books for this rail, beside (not inside) the main credits ledger. */
export const NEAR_LEDGER = {
  quotes: "credits:rail:near:quotes",
  packs: "credits:rail:near:packs",
  paidCents: "credits:rail:near:paidCents",
  /** Newest-first list of sales (capped at 50) for the /stats panel. */
  recent: "credits:rail:near:recent",
  /** Orders not yet minted, refunded or abandoned — what /stats reconciles against 1Click. */
  open: "credits:rail:near:open",
} as const;

export function nearCreditsEnabled(): boolean {
  return process.env.ENABLE_NEAR_CREDITS === "true";
}

type DepositType = "ORIGIN_CHAIN" | "INTENTS";

export interface NearOrderRecord {
  v: 1;
  tier: string;
  /** Pack price in USDC base units (6 decimals) — the exact output we asked for. */
  amountOut: string;
  destinationAsset: string;
  recipient: string;
  depositAddress: string;
  depositMemo?: string;
  secretHash: string;
  createdAt: string;
  /** AES-256-GCM of the minted token, keyed by the order secret. Set once minted. */
  sealedToken?: string;
}

export class NearOrderError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// ── 1Click client ─────────────────────────────────────────────────────────

function oneClickHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  // Without a key 1Click still quotes, but charges an extra fee on the swap.
  const jwt = process.env.NEAR_INTENTS_JWT;
  if (jwt) h.authorization = `Bearer ${jwt}`;
  return h;
}

async function oneClick<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ONECLICK_BASE}${path}`, {
    ...init,
    headers: { ...oneClickHeaders(), ...(init?.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg = (body as { message?: string } | null)?.message || text.slice(0, 300) || res.statusText;
    // A 4xx from 1Click is almost always the caller's input (unknown asset, bad
    // refund address, amount below minimum) — pass it through as a 400 so the
    // agent can fix it. 401/403 are OUR key, and anything else is upstream.
    const callerFault = res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403;
    throw new NearOrderError(`1Click ${res.status}: ${msg}`, callerFault ? 400 : 502);
  }
  return body as T;
}

let cachedAsset: string | undefined;

/** 1Click's asset id for Base USDC, looked up by contract address rather than assumed. */
export async function baseUsdcAssetId(): Promise<string> {
  if (process.env.NEAR_INTENTS_BASE_USDC_ASSET) return process.env.NEAR_INTENTS_BASE_USDC_ASSET;
  if (cachedAsset) return cachedAsset;
  try {
    const tokens = await oneClick<{ assetId: string; blockchain: string; contractAddress?: string }[]>("/v0/tokens");
    const hit = tokens.find(
      (t) => t.blockchain === "base" && (t.contractAddress || "").toLowerCase() === USDC_BASE.toLowerCase(),
    );
    if (hit) return (cachedAsset = hit.assetId);
  } catch {
    /* fall through to the known id */
  }
  return BASE_USDC_ASSET_FALLBACK;
}

/** Test hook: forget the resolved asset id. */
export function _resetAssetCache() {
  cachedAsset = undefined;
}

// ── secrets ───────────────────────────────────────────────────────────────

const hashSecret = (secret: string) => createHash("sha256").update(`near-order-id:${secret}`).digest("hex");
const encKey = (secret: string) => createHash("sha256").update(`near-order-enc:${secret}`).digest();

function seal(token: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey(secret), iv);
  const ct = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("hex")).join(".");
}

function unseal(sealed: string, secret: string): string | null {
  try {
    const [iv, tag, ct] = sealed.split(".").map((h) => Buffer.from(h, "hex"));
    const d = createDecipheriv("aes-256-gcm", encKey(secret), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── input validation ──────────────────────────────────────────────────────

/**
 * 1Click asset ids, as its /v0/tokens list spells them:
 *   nep141:wrap.near · nep141:base-0x….omft.near
 *   nep245:v2_1.omni.hot.tg:56_111…   (HOT-bridged: BNB, OP, AVAX, TON… — note the underscores)
 *   1cs_v1:btc:native:coin · 1cs_v1:hypercore:erc20:0x…
 */
export const ASSET_RE = /^(nep141|nep245|1cs_v1):[A-Za-z0-9._:\-]{2,200}$/;
/** Refund target: any chain's address or a NEAR account — shape-checked only, 1Click validates it. */
const REFUND_RE = /^[A-Za-z0-9._:\-]{2,128}$/;
export const IMPLICIT_WITH_SUFFIX = /^[0-9a-f]{64}\.near$/;

/**
 * How a buyer on this rail gets a lost token back. mintCredits' own `security`
 * text points at wallet-signature recovery, which needs the wallet that paid on
 * Base — here that is 1Click's, not the buyer's — so it is replaced.
 */
const NEAR_SECURITY =
  "This token is a bearer key — anyone holding it can spend the balance. Store it secretly. Lost it? Poll GET /api/credits/near/status again with the same orderId and x-order-secret: the same token comes back. Keep the orderSecret as safely as the token itself.";

/** Basescan link for a Base tx, when 1Click did not supply an explorer URL. */
const withExplorer = (txs: { hash: string; explorerUrl?: string }[] | undefined) =>
  (txs ?? []).map((t) => ({ hash: t.hash, explorerUrl: t.explorerUrl || `https://basescan.org/tx/${t.hash}` }));

export interface CreateOrderInput {
  tier?: string;
  originAsset?: string;
  refundTo?: string;
  depositType?: string;
}

// ── orders ────────────────────────────────────────────────────────────────

export async function createNearOrder(input: CreateOrderInput) {
  if (!kvConfigured()) throw new NearOrderError("Credits unavailable: durable storage not configured", 503);
  const payTo = getConfig().payTo;
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo || "")) throw new NearOrderError("Seller payTo not configured", 503);

  const tier = (input.tier || "").trim();
  const pack = CREDIT_TIERS[tier];
  if (!pack) throw new NearOrderError(`Invalid tier — choose one of: ${Object.keys(CREDIT_TIERS).join(", ")}`, 400);

  const originAsset = (input.originAsset || "").trim();
  if (!ASSET_RE.test(originAsset)) {
    throw new NearOrderError(
      "originAsset must be a 1Click asset id, e.g. `nep141:wrap.near` (NEAR) or `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (USDC on NEAR) — list: https://1click.chaindefuser.com/v0/tokens",
      400,
    );
  }
  const refundTo = (input.refundTo || "").trim();
  if (!REFUND_RE.test(refundTo)) {
    throw new NearOrderError("refundTo is required: where 1Click returns your funds if the swap does not complete", 400);
  }
  // A 64-hex NEAR implicit account is written WITHOUT a suffix. With ".near"
  // appended it names a different (almost always nonexistent) account, and a
  // refund sent there is lost — the first live test made exactly this mistake.
  if (IMPLICIT_WITH_SUFFIX.test(refundTo)) {
    throw new NearOrderError(
      `refundTo looks like a NEAR implicit account with ".near" appended. Implicit accounts have no suffix — use "${refundTo.slice(0, 64)}".`,
      400,
    );
  }
  const depositType: DepositType = input.depositType === "INTENTS" ? "INTENTS" : "ORIGIN_CHAIN";

  const destinationAsset = await baseUsdcAssetId();
  const amountOut = String(Math.round(pack.usd * 1_000_000)); // USDC, 6 decimals

  const quote = await oneClick<{
    signature?: string;
    quote: {
      depositAddress?: string;
      depositMemo?: string;
      amountIn: string;
      amountInFormatted: string;
      amountInUsd?: string;
      minAmountIn: string;
      deadline?: string;
      timeEstimate?: number;
    };
  }>("/v0/quote", {
    method: "POST",
    body: JSON.stringify({
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: SLIPPAGE_BPS,
      originAsset,
      depositType,
      destinationAsset,
      amount: amountOut,
      refundTo,
      refundType: depositType,
      recipient: payTo,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + DEADLINE_MS).toISOString(),
      referral: "402bazaar",
      quoteWaitingTimeMs: 3000,
    }),
  });

  const depositAddress = quote.quote?.depositAddress;
  if (!depositAddress) throw new NearOrderError("1Click returned no deposit address", 502);

  const orderId = randomBytes(12).toString("hex");
  const orderSecret = `nos_${randomBytes(24).toString("hex")}`;
  const record: NearOrderRecord = {
    v: 1,
    tier,
    amountOut,
    destinationAsset,
    recipient: payTo!.toLowerCase(),
    depositAddress,
    ...(quote.quote.depositMemo ? { depositMemo: quote.quote.depositMemo } : {}),
    secretHash: hashSecret(orderSecret),
    createdAt: new Date().toISOString(),
  };
  // Confirm the write from SET's own reply — not by reading it back, which a
  // replica can answer before it has the key (see kvSetChecked). An order we
  // did not store is a deposit we could not credit, so refuse to hand it out.
  const stored = await kvSetChecked(orderKey(orderId), JSON.stringify(record), ORDER_TTL);
  if (!stored.ok) {
    console.error(`[near-credits] order ${orderId} not stored: ${stored.detail}`);
    throw new NearOrderError(
      `Credits unavailable: order could not be stored — nothing was charged, retry shortly (${stored.detail})`,
      503,
    );
  }
  await kvIncrBy(NEAR_LEDGER.quotes, 1).catch(() => {});
  await kvSAdd(NEAR_LEDGER.open, orderId).catch(() => {});

  return {
    orderId,
    orderSecret,
    tier,
    creditsUsd: +(pack.credits / 100).toFixed(2),
    pay: {
      depositAddress,
      ...(quote.quote.depositMemo ? { depositMemo: quote.quote.depositMemo } : {}),
      depositType,
      asset: originAsset,
      amountIn: quote.quote.amountIn,
      amountInFormatted: quote.quote.amountInFormatted,
      amountInUsd: quote.quote.amountInUsd,
      minAmountIn: quote.quote.minAmountIn,
      deadline: quote.quote.deadline,
      timeEstimateSec: quote.quote.timeEstimate,
    },
    next:
      "Send `amountIn` of your asset to `depositAddress` before `deadline`. Then poll GET /api/credits/near/status?orderId=<orderId> with header `x-order-secret: <orderSecret>` every ~5s. On SUCCESS the response carries your `creditToken`.",
    security:
      "`orderSecret` is shown ONCE and is the only way to claim this order's token — store it. Polling again with it returns the same token, so a dropped response does not lose the balance.",
    quoteSignature: quote.signature,
  };
}

type OneClickStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

interface StatusResponse {
  status: OneClickStatus;
  updatedAt?: string;
  quoteResponse?: {
    quoteRequest?: { recipient?: string; destinationAsset?: string; amount?: string; swapType?: string };
  };
  swapDetails?: {
    amountOut?: string;
    refundedAmountFormatted?: string;
    refundReason?: string;
    destinationChainTxHashes?: { hash: string; explorerUrl?: string }[];
  };
}

/** Does 1Click's echo of the quote still describe the order we created? */
export function echoMatches(rec: NearOrderRecord, s: StatusResponse): boolean {
  const q = s.quoteResponse?.quoteRequest;
  if (!q) return false;
  return (
    (q.recipient || "").toLowerCase() === rec.recipient &&
    q.destinationAsset === rec.destinationAsset &&
    q.amount === rec.amountOut &&
    q.swapType === "EXACT_OUTPUT"
  );
}

export async function checkNearOrder(orderId: string, secret: string) {
  if (!/^[0-9a-f]{24}$/.test(orderId)) throw new NearOrderError("Unknown order", 404);
  const raw = await kvGet(orderKey(orderId));
  if (!raw) throw new NearOrderError("Unknown order", 404);
  const rec = JSON.parse(raw) as NearOrderRecord;
  // Unknown order and wrong secret answer the same, so orderIds cannot be probed.
  if (!secret || !secretMatches(secret, rec.secretHash)) throw new NearOrderError("Unknown order", 404);

  // Already minted: hand the same token back.
  if (rec.sealedToken) {
    const token = unseal(rec.sealedToken, secret);
    if (token) return { status: "SUCCESS" as const, creditToken: token, alreadyClaimed: true, security: NEAR_SECURITY };
  }

  const q = new URLSearchParams({ depositAddress: rec.depositAddress });
  if (rec.depositMemo) q.set("depositMemo", rec.depositMemo);
  const s = await oneClick<StatusResponse>(`/v0/status?${q}`);

  if (s.status !== "SUCCESS") {
    if (s.status === "REFUNDED" || s.status === "FAILED") await kvSRem(NEAR_LEDGER.open, orderId).catch(() => {});
    return {
      status: s.status,
      updatedAt: s.updatedAt,
      ...(s.status === "REFUNDED" || s.status === "FAILED"
        ? {
            refunded: s.swapDetails?.refundedAmountFormatted,
            reason: s.swapDetails?.refundReason,
            note: "No credits were minted. 1Click returns the deposit to your refundTo address.",
          }
        : { note: "Not settled yet — poll again in a few seconds." }),
    };
  }

  if (!echoMatches(rec, s)) {
    console.error(`[near-credits] order ${orderId}: status echo does not match the stored quote — refusing to mint`);
    throw new NearOrderError("Swap does not match this order — not credited. Contact support with your orderId.", 409);
  }

  // One mint per order, however many polls race here.
  const won = await kvSetNx(mintLockKey(orderId), ORDER_TTL);
  if (!won) {
    return {
      status: "PROCESSING" as const,
      note: "Swap settled; your credit token is being minted — poll again in a few seconds.",
    };
  }

  const pack = CREDIT_TIERS[rec.tier];
  // What actually arrived, when 1Click reports it — the books should say what we got.
  const receivedCents =
    s.swapDetails?.amountOut && /^\d+$/.test(s.swapDetails.amountOut)
      ? Math.round(Number(s.swapDetails.amountOut) / 10_000)
      : Math.round(pack.usd * 100);

  let minted: Awaited<ReturnType<typeof mintCredits>>;
  try {
    minted = await mintCredits(pack.credits, receivedCents / 100);
  } catch (err) {
    // mintCredits fails closed (no balance written), so release the lock and
    // let the next poll try again rather than leaving a paid order stuck.
    await kvDel(mintLockKey(orderId));
    throw new NearOrderError(`Swap settled but minting failed — poll again shortly (${(err as Error).message})`, 503);
  }
  rec.sealedToken = seal(minted.creditToken, secret);
  if (!(await kvSetChecked(orderKey(orderId), JSON.stringify(rec), ORDER_TTL)).ok) {
    // The token is in THIS response only; a later poll will not find it.
    console.error(`[near-credits] order ${orderId}: minted but the sealed token was not stored`);
  }
  await Promise.all([
    kvIncrBy(NEAR_LEDGER.packs, 1),
    kvIncrBy(NEAR_LEDGER.paidCents, receivedCents),
    kvSRem(NEAR_LEDGER.open, orderId),
  ]).catch(() => {});
  // Each sale, for the owner's /stats panel — the demand signal the NEAR plan
  // waits on. Inside the mint lock, so one row per order. Best-effort: the
  // counters above are the books; this is the list you read them by.
  await kvLPush(
    NEAR_LEDGER.recent,
    JSON.stringify({
      t: new Date().toISOString(),
      usd: +(receivedCents / 100).toFixed(2),
      creditsUsd: +(pack.credits / 100).toFixed(2),
      tx: s.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? null,
      orderId,
    }),
    50,
  ).catch(() => {});

  return {
    status: "SUCCESS" as const,
    ...minted,
    security: NEAR_SECURITY,
    settlement: withExplorer(s.swapDetails?.destinationChainTxHashes),
  };
}

/** How long an order with no deposit is kept open before it counts as abandoned. */
const ABANDONED_AFTER_MS = 4 * 24 * 60 * 60 * 1000; // 1Click's deposit window is ~3 days
const MAX_OPEN_CHECKED = 30;

export interface UnclaimedOrder {
  orderId: string;
  tier: string;
  usd: number;
  createdAt: string;
  /** After this the order record expires and the buyer can no longer claim the token. */
  claimableUntil: string;
}

/**
 * Reconcile open orders against 1Click for the owner's panel.
 *
 * The case this exists for: a buyer deposits, the swap settles and the USDC
 * reaches us, but nobody ever polls the status endpoint — so no token is minted
 * and nothing in the books shows the sale. We cannot mint on their behalf (the
 * token is sealed under their order secret, which we never store), but the
 * owner should see money that arrived for credit not yet handed out.
 *
 * Also prunes the index: minted, refunded, expired and abandoned orders leave it.
 */
export async function nearOpenOrders(): Promise<{ unclaimed: UnclaimedOrder[]; unclaimedUsd: number; inFlight: number } | null> {
  if (!kvConfigured()) return null;
  const ids = (await kvSMembers(NEAR_LEDGER.open)).slice(0, MAX_OPEN_CHECKED);
  const unclaimed: UnclaimedOrder[] = [];
  let inFlight = 0;
  await Promise.all(
    ids.map(async (id) => {
      const raw = await kvGet(orderKey(id));
      const rec = raw ? (JSON.parse(raw) as NearOrderRecord) : null;
      if (!rec || rec.sealedToken) {
        await kvSRem(NEAR_LEDGER.open, id); // expired, or minted
        return;
      }
      let status: string;
      try {
        const q = new URLSearchParams({ depositAddress: rec.depositAddress });
        if (rec.depositMemo) q.set("depositMemo", rec.depositMemo);
        status = (await oneClick<StatusResponse>(`/v0/status?${q}`)).status;
      } catch {
        inFlight++; // 1Click unreachable: leave it for the next look
        return;
      }
      const age = Date.now() - Date.parse(rec.createdAt);
      if (status === "SUCCESS") {
        unclaimed.push({
          orderId: id,
          tier: rec.tier,
          usd: +(Number(rec.amountOut) / 1_000_000).toFixed(2),
          createdAt: rec.createdAt,
          claimableUntil: new Date(Date.parse(rec.createdAt) + ORDER_TTL * 1000).toISOString(),
        });
      } else if (status === "REFUNDED" || status === "FAILED" || (status === "PENDING_DEPOSIT" && age > ABANDONED_AFTER_MS)) {
        await kvSRem(NEAR_LEDGER.open, id);
      } else {
        inFlight++;
      }
    }),
  );
  unclaimed.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { unclaimed, unclaimedUsd: +unclaimed.reduce((a, o) => a + o.usd, 0).toFixed(2), inFlight };
}

/** Owner-facing numbers for this rail. Null when there is no durable store. */
export async function nearRailLedger() {
  if (!kvConfigured()) return null;
  const [quotes, packs, paidCents, recentRaw] = await Promise.all([
    kvGetNumber(NEAR_LEDGER.quotes),
    kvGetNumber(NEAR_LEDGER.packs),
    kvGetNumber(NEAR_LEDGER.paidCents),
    kvLRange(NEAR_LEDGER.recent, 0, 19),
  ]);
  const recent = recentRaw.flatMap((r) => {
    try {
      return [JSON.parse(r) as { t: string; usd: number; creditsUsd: number; tx: string | null; orderId: string }];
    } catch {
      return [];
    }
  });
  return {
    enabled: nearCreditsEnabled(),
    quotes,
    packsSold: packs,
    paidUsd: +(paidCents / 100).toFixed(2),
    /** Quotes that turned into a paid pack — the conversion this rail lives or dies by. */
    conversionPct: quotes > 0 ? +((packs / quotes) * 100).toFixed(1) : 0,
    /** Latest sales, newest first. Sales before this list existed are counted above but not listed. */
    recent,
  };
}
