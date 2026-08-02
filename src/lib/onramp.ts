/**
 * Fiat rails — what it actually costs to get money on and off chain, per country.
 *
 * WHY THIS EXISTS: every agent that touches a real user eventually hits the fiat
 * boundary, and the answers there are country-shaped, not chain-shaped. Can
 * someone in Germany fund this wallet? With a card, or only a bank transfer?
 * What is the minimum? And — the question nobody publishes — what does each
 * method actually cost? On the same $100 the spread is not small: card takes
 * 2.44, ACH takes 0.50, a funded fiat wallet takes nothing. That is a 5x
 * difference in fees that an agent can act on, and it is invisible unless you
 * quote every method separately, which is exactly what these two endpoints do.
 *
 * Source is Coinbase's own onramp/offramp API on our existing CDP credentials —
 * no separate onboarding, no partner agreement, and the fee numbers are the ones
 * a buyer would really be charged rather than a published rate card.
 *
 * THE SAFETY RULE IN HERE: a quote comes back with a `pay.coinbase.com` checkout
 * URL that has the destination address baked into its session. If the caller did
 * not give us an address, we must not invent one — a URL pointing at a
 * placeholder would send a real person's real money to an address nobody
 * controls. So the URL is returned only when the caller supplied the address it
 * pays out to, and its absence is explained rather than silent.
 */

import "server-only";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { getConfig } from "./config";
import { finish } from "./envelope";

const HOST = "api.developer.coinbase.com";
const TIMEOUT_MS = 10_000;

/** Payment rails Coinbase can quote. CRYPTO_ACCOUNT is excluded deliberately:
 *  it is "pay with crypto you already hold", which is not an onramp and the
 *  quote endpoint rejects it outright. */
const METHODS = ["CARD", "APPLE_PAY", "ACH_BANK_ACCOUNT", "FIAT_WALLET", "PAYPAL", "RTP", "SEPA", "IDEAL"] as const;

const COUNTRY = /^[A-Za-z]{2}$/;
const CCY = /^[A-Za-z]{3}$/;
const ASSET = /^[A-Za-z0-9]{2,12}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

interface Money {
  value?: string;
  currency?: string;
}
interface Quote {
  payment_total?: Money;
  payment_subtotal?: Money;
  purchase_amount?: Money;
  coinbase_fee?: Money;
  network_fee?: Money;
  quote_id?: string;
  onramp_url?: string;
}
interface Limit {
  id?: string;
  min?: string;
  max?: string;
}
interface Currency {
  id?: string;
  limits?: Limit[];
}
interface Asset {
  symbol?: string;
  name?: string;
  networks?: Array<{ name?: string; display_name?: string; chain_id?: string }>;
}

/** Call CDP. Throws on transport failure and on non-2xx we didn't ask about, so
 *  a broken upstream fails the request before x402 settles rather than billing
 *  for a shrug. Expected 4xx (country/amount/asset rejections) are handed back
 *  to the caller instead, because those ARE the answer. */
async function cdp<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<{ ok: boolean; status: number; data: T; message: string | null }> {
  const cfg = getConfig();
  if (!cfg.cdpApiKeyId || !cfg.cdpApiKeySecret) throw new Error("Fiat rails not configured: set CDP_API_KEY_ID and CDP_API_KEY_SECRET");
  const jwt = await generateJwt({
    apiKeyId: cfg.cdpApiKeyId,
    apiKeySecret: cfg.cdpApiKeySecret,
    requestMethod: method,
    requestHost: HOST,
    requestPath: path.split("?")[0],
  });
  const res = await fetch(`https://${HOST}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => null)) as T & { message?: string };
  if (res.status >= 500 || !data) throw new Error(`Coinbase onramp API responded ${res.status}`);
  // CDP prefixes its messages ("InvalidRequest: payment method CARD is not
  // supported by country TR") — keep the human half, drop the code.
  const raw = typeof data.message === "string" ? data.message : null;
  return { ok: res.ok, status: res.status, data, message: raw ? raw.replace(/^[A-Za-z]+:\s*/, "") : null };
}

const num = (m: Money | undefined) => (m?.value != null && m.value !== "" ? Number(m.value) : null);

// ---------------------------------------------------------------------------
// onramp-quote
// ---------------------------------------------------------------------------

/**
 * Price the same purchase across every payment method the country allows, and
 * rank them by what the buyer actually receives.
 *
 * The ranking is on `received`, not on the headline fee: a method can carry a
 * smaller Coinbase fee and still deliver less once the network fee is in, and
 * the buyer only cares about the last number.
 */
export async function onrampQuote(params: Record<string, string>) {
  const country = (params.country || "").trim().toUpperCase();
  if (!COUNTRY.test(country)) throw new Error("Provide a 2-letter ISO country code (country=US)");
  const amountRaw = (params.amount || "").trim();
  const amount = Number(amountRaw);
  if (!amountRaw || !Number.isFinite(amount) || amount <= 0) throw new Error("Provide a positive fiat amount (amount=100)");
  const asset = (params.asset || "USDC").trim().toUpperCase();
  if (!ASSET.test(asset)) throw new Error("Provide a valid asset symbol (asset=USDC)");
  const network = (params.network || "base").trim().toLowerCase();
  const currency = (params.currency || "USD").trim().toUpperCase();
  if (!CCY.test(currency)) throw new Error("Provide a 3-letter fiat currency (currency=USD)");
  const address = (params.address || "").trim();
  if (address && !ADDRESS.test(address)) throw new Error("address= must be a 0x… wallet address");

  // Which rails does this country have at all? One call, and it also tells us
  // the limits, so an out-of-range amount is explained rather than just refused.
  const opts = await cdp<{ payment_currencies?: Currency[]; purchase_currencies?: Asset[] }>(`/onramp/v1/buy/options?country=${country}`, "GET");
  if (!opts.ok) {
    return finish({
      country,
      supported: false,
      reason: opts.message ?? `Coinbase does not list buy options for ${country}`,
      quotes: [],
      note: NOTE,
    });
  }
  const fiat = (opts.data.payment_currencies ?? []).find((c) => (c.id ?? "").toUpperCase() === currency);
  const available = fiat ? [...new Set((fiat.limits ?? []).map((l) => l.id).filter((x): x is string => Boolean(x)))] : [];
  // Coinbase lists some methods twice for the same currency (APPLE_PAY appears
  // once per underlying card network). Identical rows would read as two
  // different limits, so keep the first per method.
  const seen = new Set<string>();
  const limits = (fiat?.limits ?? [])
    .filter((l) => l.id && !seen.has(l.id) && seen.add(l.id))
    .map((l) => ({ method: l.id ?? null, min: l.min ?? null, max: l.max ?? null }));

  if (!available.length) {
    // No fiat rail. This is the common answer for most of the world and it is a
    // real result, not an error — say what IS possible instead of just "no".
    const assets = (opts.data.purchase_currencies ?? []).length;
    return finish({
      country,
      currency,
      supported: false,
      reason: `Coinbase Onramp has no ${currency} payment method for ${country}. ${assets} assets are listed as purchasable there, but only by transferring crypto in — there is no card or bank rail from this country.`,
      availableMethods: [],
      quotes: [],
      note: NOTE,
    });
  }

  // Quote every rail at once. A rejection per method is informative (usually a
  // min/max breach), so failures are collected rather than thrown away.
  const wanted = METHODS.filter((m) => available.includes(m));
  const results = await Promise.all(
    wanted.map(async (method) => {
      try {
        const q = await cdp<Quote>("/onramp/v1/buy/quote", "POST", {
          purchase_currency: asset,
          purchase_network: network,
          payment_amount: amount.toFixed(2),
          payment_currency: currency,
          payment_method: method,
          country,
          destination_address: address || PLACEHOLDER,
        });
        if (!q.ok) return { method, available: false as const, reason: q.message ?? `rejected (${q.status})` };
        const received = num(q.data.purchase_amount);
        const fee = num(q.data.coinbase_fee) ?? 0;
        const netFee = num(q.data.network_fee) ?? 0;
        return {
          method,
          available: true as const,
          received,
          receivedAsset: q.data.purchase_amount?.currency ?? asset,
          coinbaseFee: fee,
          networkFee: netFee,
          totalFee: +(fee + netFee).toFixed(6),
          feePct: amount > 0 ? +(((fee + netFee) / amount) * 100).toFixed(3) : null,
          // Only when the caller told us where the money should land. See the
          // file header: a checkout URL aimed at a placeholder is a way to lose
          // someone's money, so it is withheld rather than defaulted.
          checkoutUrl: address ? (q.data.onramp_url ?? null) : null,
        };
      } catch (e) {
        return { method, available: false as const, reason: e instanceof Error ? e.message : "quote failed" };
      }
    }),
  );

  const priced = results.filter((r): r is Extract<typeof r, { available: true }> => r.available && r.received != null);
  priced.sort((a, b) => (b.received ?? 0) - (a.received ?? 0));
  const best = priced[0] ?? null;
  const worst = priced[priced.length - 1] ?? null;

  return finish({
    country,
    currency,
    asset,
    network,
    amount,
    supported: priced.length > 0,
    availableMethods: available,
    limits,
    cheapest: best ? { method: best.method, received: best.received, totalFee: best.totalFee, feePct: best.feePct } : null,
    // The spread is the reason to call this at all: it is what an agent saves by
    // steering a user to a different rail.
    spread:
      best && worst && best !== worst
        ? { betterBy: +((best.received ?? 0) - (worst.received ?? 0)).toFixed(6), versus: worst.method }
        : null,
    quotes: results,
    checkoutUrlNote: address
      ? "checkoutUrl pays out to the address you supplied."
      : "No address= was given, so no checkout URL is returned — a checkout link carries its destination inside it, and one built on a placeholder would send real funds to an address nobody controls. Pass address= to get a payable link.",
    recommendation: best
      ? `Cheapest rail in ${country} is ${best.method}: ${best.received} ${best.receivedAsset} for ${amount} ${currency} (${best.feePct}% in fees).` +
        (worst && worst !== best ? ` The worst available rail, ${worst.method}, delivers ${worst.received} — steering the user costs nothing and saves the difference.` : "")
      : `No ${currency} rail in ${country} could quote ${amount}. See quotes[] for why each was rejected — usually the amount is outside that method's min/max.`,
    note: NOTE,
  });
}

/** Quotes are indifferent to the destination, but the API insists on a
 *  well-formed one. This address is only ever used to satisfy that check, and
 *  any URL built on it is discarded before it reaches the caller. */
const PLACEHOLDER = "0x0000000000000000000000000000000000000001";

const NOTE =
  "Live Coinbase Onramp pricing per country and payment method. Fees are what a buyer is actually charged, not a rate card. Availability and limits are Coinbase's and can change. Not financial advice.";

// ---------------------------------------------------------------------------
// onramp-coverage
// ---------------------------------------------------------------------------

/**
 * Can money move in and out of crypto in this country at all, and how.
 *
 * Separate from the quote because it answers a different question: the quote
 * prices one purchase, this one is the feasibility check an agent runs before
 * it ever asks a user for money. It covers both directions — plenty of
 * countries can buy but not cash out.
 */
export async function onrampCoverage(params: Record<string, string>) {
  const country = (params.country || "").trim().toUpperCase();
  if (!COUNTRY.test(country)) throw new Error("Provide a 2-letter ISO country code (country=DE)");

  const [buy, sell] = await Promise.all([
    cdp<{ payment_currencies?: Currency[]; purchase_currencies?: Asset[] }>(`/onramp/v1/buy/options?country=${country}`, "GET"),
    cdp<{ cashout_currencies?: Currency[]; sell_currencies?: Asset[] }>(`/onramp/v1/sell/options?country=${country}`, "GET"),
  ]);

  if (!buy.ok && !sell.ok) {
    return finish({
      country,
      buy: { supported: false, reason: buy.message ?? `not listed (${buy.status})` },
      sell: { supported: false, reason: sell.message ?? `not listed (${sell.status})` },
      verdict: "unsupported",
      recommendation: `Coinbase Onramp does not operate in ${country} in either direction.`,
      note: NOTE,
    });
  }

  const fiatIn = (buy.data?.payment_currencies ?? []).map((c) => ({
    currency: c.id ?? null,
    methods: (c.limits ?? []).map((l) => ({ method: l.id ?? null, min: l.min ?? null, max: l.max ?? null })),
  }));
  const fiatOut = (sell.data?.cashout_currencies ?? []).map((c) => ({
    currency: c.id ?? null,
    methods: (c.limits ?? []).map((l) => ({ method: l.id ?? null, min: l.min ?? null, max: l.max ?? null })),
  }));

  const assets = buy.data?.purchase_currencies ?? [];
  const networks = [...new Set(assets.flatMap((a) => (a.networks ?? []).map((n) => n.name).filter((x): x is string => Boolean(x))))].sort();
  const methodsIn = [...new Set(fiatIn.flatMap((c) => c.methods.map((m) => m.method).filter((x): x is string => Boolean(x))))];
  const methodsOut = [...new Set(fiatOut.flatMap((c) => c.methods.map((m) => m.method).filter((x): x is string => Boolean(x))))];

  const canBuy = methodsIn.length > 0;
  const canSell = methodsOut.length > 0;
  const verdict = canBuy && canSell ? "both" : canBuy ? "buy_only" : canSell ? "sell_only" : "crypto_transfer_only";

  return finish({
    country,
    verdict, // both | buy_only | sell_only | crypto_transfer_only | unsupported
    buy: { supported: canBuy, methods: methodsIn, currencies: fiatIn.map((c) => c.currency), limits: fiatIn },
    sell: { supported: canSell, methods: methodsOut, currencies: fiatOut.map((c) => c.currency), limits: fiatOut },
    assets: { count: assets.length, networks, sample: assets.slice(0, 10).map((a) => a.symbol ?? null) },
    recommendation: canBuy
      ? `${country} has ${methodsIn.length} fiat-in rail(s): ${methodsIn.join(", ")}. ${canSell ? `Cashing out works too (${methodsOut.join(", ")}).` : "There is no cash-out rail — funds can come in but not back out through Coinbase here."} ${assets.length} assets across ${networks.length} networks.`
      : `${country} has no fiat rail: crypto can be received and purchased only by transferring in existing crypto. ${assets.length} assets are listed. Route users through a local exchange or a country that does have a rail.`,
    note: NOTE,
  });
}
