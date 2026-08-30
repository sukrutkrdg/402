/**
 * SELLER — the paid marketplace endpoints.
 *
 * A single dynamic route serves every service in the catalog. For each request
 * we look up the service, build its x402 RouteConfig (price + Builder Code app
 * code `a`), and wrap the real handler with `withX402`. `withX402` only settles
 * the payment *after* the handler returns a < 400 response, so buyers never pay
 * for an error.
 */

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withX402, type RouteConfig } from "@x402/next";
import { BUILDER_CODE, declareBuilderCodeExtension } from "@x402/extensions/builder-code";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { getResourceServer } from "@/lib/x402-server";
import { getService } from "@/lib/services";
import { NETWORK, getConfig, getSiteUrl } from "@/lib/config";
import { consumeFree } from "@/lib/free-tier";
import { toPreview } from "@/lib/preview";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";
import { logUsage, srcHash } from "@/lib/usage";
import { kvGet, kvSet, kvDel, kvIncrBy } from "@/lib/kv";
import { debitCredit, refundCredit, tierPrice, linkCreditOwner } from "@/lib/credits";
import { sinceLastCheck } from "@/lib/since-last";
import { riskSignal, isRefundable, withBaseReceipt } from "@/lib/envelope";
import { withRelated } from "@/lib/related";
import { saveSample, loadSample } from "@/lib/sample-cache";
import { exampleInputFor, staticOutputExample } from "@/lib/discovery-examples";
import { priceCents } from "@/lib/price";
import { payerFromHeaders } from "@/lib/payer";
import { indexFreshKey, INDEX_FRESH_SECONDS } from "@/lib/index-freshness";
import { tagsFor } from "@/lib/tags";
import { returningCallerNote } from "@/lib/repeat-caller";
import { loadPreview, savePreview } from "@/lib/preview-cache";



/** Static input→output pairs served inside the 402 challenge for the
 * text-transform AI services (the biggest probe magnets). Never computed —
 * an unpaid handler run would be a cost-drain vector. */
const CHALLENGE_EXAMPLES: Record<string, Record<string, unknown>> = {
  "ai-extract": {
    request: "?text=Invoice %2318 from Acme Corp, due 2026-08-01, total $420.50, contact billing@acme.io&fields=invoice_no,company,due_date,total,email",
    response: { invoice_no: "18", company: "Acme Corp", due_date: "2026-08-01", total: "$420.50", email: "billing@acme.io" },
    tip: "Add list=true to extract EVERY repeated record (rows, line items, listings) as an array. Batch 10 documents in one call: ai-extract-batch.",
  },
  "ai-translate": {
    request: "?text=Der Vertrag endet am 1. August und verlängert sich automatisch.&to=English",
    response: { to: "English", translation: "The contract ends on August 1 and renews automatically." },
    tip: "Any source language, any target (to=Spanish, to=Japanese…). Up to 6K characters; the response is the bare translation — safe to pipe into the next step.",
  },
  "ai-summarize": {
    request: "?text=<a 16K-char article, transcript or email thread>",
    response: { bullets: ["Q2 revenue grew 18% to $4.2M, driven by the enterprise tier", "Two security incidents were disclosed; both patched within 24h", "Guidance for Q3 raised to $4.6-4.8M"] },
    tip: "3-5 fact-dense bullets from up to 16K characters — the digest step for agents that read more than their context carries.",
  },
};

export const dynamic = "force-dynamic";
// AI services aggregate several upstreams + Claude, and x402 settlement adds a few
// seconds — well over the serverless default. Give the handler room so paid AI
// reports (e.g. the mini-app) don't time out AFTER the buyer has paid.
export const maxDuration = 60;

function paramsFrom(request: NextRequest, service: ReturnType<typeof getService>) {
  const url = new URL(request.url);
  const params: Record<string, string> = {};
  for (const p of service!.params) {
    const v = url.searchParams.get(p.name);
    // Defensive ceiling. Most params are short (addresses etc.) so 2000 is plenty,
    // but the text-AI services legitimately take large inputs — text/texts/text1..N
    // up to ~16K each (ai-extract-batch joins up to ~40K). Those params get a wider
    // cap so the handler's own clamp (16K/6K) is the real limit, not this slice.
    // Without this the paid AI tools silently processed only the first 2000 chars.
    if (v) {
      const wide = /^text(s|\d+)?$/i.test(p.name);
      params[p.name] = v.slice(0, wide ? 45000 : 2000);
    }
  }
  return params;
}

/**
 * What this call actually costs, for BOTH rails.
 *
 * This exists because the two rails computed it separately and drifted. When
 * `url-to-json` was split by mode — $0.01 for a default extraction, $0.06 for
 * `list=true`, whose 8000-token budget costs us ~$0.044 in model spend — the
 * uplift was added to the x402 challenge only. The credit rail kept debiting the
 * declared $0.01, so a prepaid caller bought the expensive mode for a sixth of
 * its price and the response cheerfully reported `chargedUsd: 0.01`. A $0.25
 * credit pack was worth about $1.10 of Anthropic spend to anyone who noticed.
 *
 * One function, both callers. A future price rule added here cannot reach one
 * rail and miss the other.
 */
async function effectivePriceFor(
  service: NonNullable<ReturnType<typeof getService>>,
  req: NextRequest,
): Promise<string> {
  if (service.id === "buy-credits") {
    // The challenge amount is the chosen pack's price (tier=0.25|1|5|20).
    return tierPrice(paramsFrom(req, service).tier || "");
  }
  if (service.id === "url-to-json") {
    const list = String(paramsFrom(req, service).list ?? "").trim();
    // Must stay identical to the listMode test in src/lib/ai.ts.
    if (/^(true|1|yes)$/i.test(list)) return "$0.06";
    return service.price;
  }
  if (service.id === "ai-token-report") {
    // Coupon-discounted: a caller who just paid the entry check on this token
    // gets the report for less. Falls back to full price if absent — never
    // cheaper without a real prior purchase.
    try {
      const addr = String(paramsFrom(req, service).address ?? "").toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(addr) && (await kvGet(`coupon:${srcHash(clientIp(req))}:${addr}`))) {
        return "$0.05";
      }
    } catch {
      /* fall back to full price */
    }
  }
  return service.price;
}

/**
 * Post-payment funnel bookkeeping, shared by the x402 and credit pay paths so
 * both kinds of payer get the same product: paying the entry check mints a 1h
 * coupon for the AI report on the same token; a paid re-check attaches the
 * since-last diff; redeeming the AI report consumes the coupon. Best-effort —
 * never blocks or breaks a paid response.
 */
async function attachRetention(serviceId: string, data: unknown, src: string): Promise<void> {
  try {
    const d = data as Record<string, unknown> | null;
    const addr = String(d?.address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return;
    if (serviceId === "token-risk" || serviceId === "rug-score") {
      await kvSet(`coupon:${src}:${addr}`, "1", 3600);
      // One place knows the score/level field aliases across services.
      const sig = riskSignal(d);
      if (sig.score !== null && d) {
        // Keyed per service: token-risk and rug-score scores are different
        // methodologies — diffing one against the other fabricates movement.
        const sl = await sinceLastCheck(src, `${serviceId}:${addr}`, sig.score, sig.level ?? "");
        if (sl) d.sinceLastCheck = sl;
      }
    } else if (serviceId === "ai-token-report") {
      await kvDel(`coupon:${src}:${addr}`);
    }
  } catch {
    /* retention bookkeeping is best-effort */
  }
}

/**
 * Strip the generated `routeTemplate` from the payment-required header.
 *
 * `withX402` hardcodes a `"*"` route pattern, and the bazaar extension turns a
 * wildcard segment into `:var1`. Every one of our services therefore declared
 * `routeTemplate: ":var1"`, which cannot match a concrete resource URL — so the
 * Bazaar's `matches_resource` check fails and the resource is not indexed. It is
 * a known upstream bug (x402-foundation/x402#3019), and we are the largest
 * single contributor to it in the public index: 103 of the 248 malformed records
 * are ours.
 *
 * Removing the field is the right repair rather than substituting a real
 * template. With no `routeTemplate` the indexer falls back to the request's own
 * pathname, which is exactly the per-service URL we want indexed. Declaring
 * `/api/x402/:service` instead would be worse than the bug: it is a single
 * template, so all 131 services would collapse into one canonical resource.
 *
 * Only the header carries it — the 402 body does not — and nothing is signed
 * over it, so rewriting is safe for verification and settlement.
 */
function fixRouteTemplate(headers: Headers): void {
  for (const name of ["payment-required", "x-payment-required"]) {
    const raw = headers.get(name);
    if (!raw) continue;
    try {
      const decl = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
        extensions?: Record<string, { routeTemplate?: unknown }>;
      };
      const bazaar = decl.extensions?.bazaar;
      if (!bazaar || typeof bazaar.routeTemplate !== "string") continue;
      if (!/^:var\d+$|(^|\/):var\d+(\/|$)/.test(bazaar.routeTemplate)) continue; // a real template — leave it
      delete bazaar.routeTemplate;
      headers.set(name, Buffer.from(JSON.stringify(decl), "utf8").toString("base64"));
    } catch {
      /* an unreadable header is the library's to own — never break the challenge */
    }
  }
}

/** Constant-time secret compare (avoids leaking length/match via timing). */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Map a handler error to an honest HTTP response: 400 for bad/missing input or
 * no data for this input, 502 for upstream unavailability, 500 otherwise.
 * Used on every serve path — a data error must never surface as a blanket 503.
 */
function handlerErrorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : "Service error";
  const m = message.toLowerCase();
  const status =
    // "must be", "too large/long", "choose one of", "not a" and "unsupported"
    // are all the caller's input talking. A health sweep caught `business-days`
    // answering 500 to a malformed date — telling an agent "our fault, retry"
    // when retrying the same input can only fail again.
    /provide|missing|valid|invalid|required|must be|too (large|long|many)|choose one of|unsupported|not a |no .*found|no .*data|no .*available|no price/.test(m)
      ? 400
      : /unavailable|failed|responded \d|timeout|fetch/.test(m)
        ? 502
        : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ service: string }> }) {
  const { service: serviceId } = await ctx.params;
  const service = getService(serviceId);
  if (!service) {
    return NextResponse.json({ error: `Unknown service: ${serviceId}` }, { status: 404 });
  }

  // Generous per-IP cap to blunt DoS (each call can fan out to RPC/GoPlus/DexScreener
  // before payment is even validated). Legit agents stay well under this.
  const rl = await rateLimitKv(`x402:${clientIp(req)}`, 60, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  const cfg = getConfig();

  // Internal-auth bypass: trusted first-party services (Warden / warden402.xyz)
  // send `X-Warden-Internal: <secret>` to call paid endpoints WITHOUT settling
  // x402 — so our own products don't bill themselves. Only active when
  // WARDEN_INTERNAL_SECRET is configured; compared in constant time. Still
  // counts toward usage logs (as internal) and is rate-limited above.
  // buy-credits is excluded: the bypass exists so first-party products skip
  // BILLING, not so a leaked/first-party secret can MINT spendable credit
  // balances without any settlement.
  const internalHeader = req.headers.get("x-warden-internal");
  if (cfg.internalSecret && internalHeader && secretMatches(internalHeader, cfg.internalSecret) && service.id !== "buy-credits") {
    try {
      const data = await service.handler(paramsFrom(req, service));
      const ip = clientIp(req);
      await logUsage(service.id, false, srcHash(ip), req.headers.get("user-agent") || "warden-internal", req.headers.get("referer") || "", true);
      return NextResponse.json(
        { service: service.id, builderCode: cfg.appBuilderCode, data, internal: true },
        { headers: { "x-warden-internal": "ok" } },
      );
    } catch (err) {
      return handlerErrorResponse(err);
    }
  }

  // Prepaid-credit path (P3): a caller who bought a credit pack presents its
  // bearer token as `x-credit-token` and draws the service price down from their
  // balance — no per-call x402 settlement. Revenue was collected up front when the
  // pack was bought; this only debits it. buy-credits itself is excluded (you can't
  // mint credits from credits — that needs a real settlement).
  const creditToken = req.headers.get("x-credit-token") || "";
  if (creditToken && service.id !== "buy-credits") {
    // Credit payers get the same funnel prices as x402 payers: an unexpired
    // coupon (earned by paying the entry check on this token) discounts the AI
    // report here exactly as it discounts the x402 challenge.
    const cents = priceCents(await effectivePriceFor(service, req));
    // Debit FIRST (atomic DECRBY, fail-closed): this both charges and reserves in
    // one step, so two concurrent calls can't each pass a cheap pre-check and get a
    // free call on the race. An underfunded/unknown token is refunded inside
    // debitCredit and reported here.
    const debit = await debitCredit(creditToken, cents);
    if (!debit.ok) {
      // This is a price wall too — log it as a challenge so the funnel counts
      // credit-exhausted callers, not just x402 walk-aways.
      await logUsage(service.id, false, srcHash(clientIp(req)), req.headers.get("user-agent") || "", req.headers.get("referer") || "", false, false, true);
      return NextResponse.json(
        {
          error: debit.reason === "insufficient" ? "Insufficient credits" : "Invalid or unusable credit token",
          service: service.id,
          priceUsd: +(cents / 100).toFixed(2),
          balanceUsd: +((debit.balance ?? 0) / 100).toFixed(2),
          topUp: "Buy more at /api/x402/buy-credits (tier=0.25|1|5|20), or omit x-credit-token to pay per-call via x402.",
        },
        { status: 402 },
      );
    }
    let data: unknown;
    try {
      const p = paramsFrom(req, service);
      data = withBaseReceipt(await service.handler(p), service.id, p);
    } catch (err) {
      await refundCredit(creditToken, cents); // charged but never delivered → give it back
      return handlerErrorResponse(err);
    }
    await saveSample(service.id, data);
    const ip = clientIp(req);
    await attachRetention(service.id, data, srcHash(ip));
    await logUsage(service.id, true, srcHash(ip), req.headers.get("user-agent") || "", req.headers.get("referer") || "", false, false, false, srcHash(`credit:${creditToken}`));
    // Refund rule (decision receipt): a refusal — a low-confidence non-decision
    // because our core data feed was unavailable — is delivered but NOT billed.
    // Give the debit back and tell the caller via `x-refunded`.
    const refunded = isRefundable(data);
    if (refunded) await refundCredit(creditToken, cents);
    const remaining = refunded ? debit.remaining + cents : debit.remaining;
    return NextResponse.json(
      withRelated({
        service: service.id,
        builderCode: cfg.appBuilderCode,
        data,
        paidVia: refunded ? "credits-refunded" : "credits",
        // What we actually took, not what the price string says. They differ for
        // sub-cent services, and the buyer should see that rather than discover it.
        chargedUsd: refunded ? 0 : +(cents / 100).toFixed(3),
        creditBalanceUsd: +(remaining / 100).toFixed(2),
        ...(refunded ? { refunded: true, refundReason: "Refusal (core data feed unavailable) — not billed per this check's refundRule." } : {}),
      }, service.id),
      { headers: { "x-credit-balance": String(remaining), "x-paid-via": "credits", ...(refunded ? { "x-refunded": "true" } : {}) } },
    );
  }

  // Free tier: one free trial call/day per IP, then a preview. This is the agent
  // trial funnel — but it now has to be ASKED for (`?free=1`, or the
  // `x-402-free: 1` header).
  //
  // Why opt-in, when it used to be automatic: an unpaid GET that answers 200
  // never shows the caller a payment challenge, and the discovery indexer reads
  // the challenge to learn what an endpoint sells. Every one of our free-eligible
  // endpoints was therefore invisible in the catalogue — 35 of them, some paid
  // dozens of times over months — while every paid-only endpoint was listed
  // within a second of its first settlement. Proven twice: flipping `gas-oracle`
  // and `ens-resolve` to paid-only put both in the index on the next payment,
  // after months of nothing. A trial nobody can discover is worth less than the
  // listing it was costing us, so the default answer to a bare request is now
  // the 402 — which is also what every x402 client already expects.
  const hasPayment = Boolean(req.headers.get("x-payment") || req.headers.get("payment-signature"));
  const forcePay = req.headers.get("x-x402-force") === "1";
  const freeAsked =
    new URL(req.url).searchParams.get("free") === "1" || req.headers.get("x-402-free") === "1";
  // AI services have real upstream cost (Claude) — never give them away on the
  // free tier (the in-memory counter resets per serverless instance, so free
  // AI calls could run up the owner's bill). Cheap RPC services stay free-eligible.
  const freeEligible = service.category !== "AI" && !service.noFreeTier;
  if (!hasPayment && !forcePay && freeEligible && freeAsked) {
    const ip = clientIp(req);
    // Keyed per IP AND service: every published surface (MCP readme/registry,
    // server card, catalog) promises "one free call per day per service" — one
    // shared daily call across 60+ tools broke that promise 65 times over.
    const free = await consumeFree(`free:${ip}:${service.id}`);
    if (free.allowed) {
      try {
        const data = await service.handler(paramsFrom(req, service));
        await saveSample(service.id, data);
        await logUsage(service.id, false, srcHash(ip), req.headers.get("user-agent") || "", req.headers.get("referer") || "");
        return NextResponse.json(
          { service: service.id, builderCode: cfg.appBuilderCode, data, freeTier: true, freeRemaining: free.remaining },
          { headers: { "x-free-tier": "true", "x-free-remaining": String(free.remaining) } },
        );
      } catch (err) {
        return handlerErrorResponse(err);
      }
    } else if (free.degraded) {
      // We could not count the free call, which means nothing below can be
      // metered either: the preview cache lives in the same KV, and the preview
      // limiter degrades to a per-instance counter that a cold start resets. The
      // preview path runs the FULL handler, so serving it here would answer an
      // outage by giving the upstream cost away without limit. Fall through to
      // the paid path instead — the caller gets a normal 402 and can still buy.
    } else {
      // Daily free full report already used → return a PREVIEW (headline scalars +
      // "N signals found") instead of a hard 402 wall. The teaser creates the
      // pull; the full detail is what a paid call unlocks.
      const params = paramsFrom(req, service);
      // The highest-intent unpaid caller (used their free check, came back) sees
      // this — so carry the same upsell the paid response would. For a token
      // check, the natural next step is the AI report on this exact token.
      const previewAddr = String(params.address ?? "").toLowerCase();
      const previewUpgrade =
        (service.id === "token-risk" || service.id === "rug-score") && /^0x[0-9a-f]{40}$/.test(previewAddr)
          ? {
              service: "ai-token-report",
              price: "$0.12",
              why: "AI-written buy/avoid verdict on this token — pay this check first and the full report is $0.05 (not $0.12) on this token for the next hour.",
              url: `${getSiteUrl()}/api/x402/ai-token-report?address=${previewAddr}`,
            }
          : null;
      const previewBody = (data: Record<string, unknown>) =>
        NextResponse.json(
          {
            service: service.id,
            builderCode: cfg.appBuilderCode,
            data,
            preview: true,
            unlock: `Free daily check used — this is a preview. Pay ${service.price} for the full report (all signals, details & recommendation).`,
            ...(previewUpgrade ? { upgrade: previewUpgrade } : {}),
          },
          { headers: { "x-preview": "true" } },
        );

      // Serve a cached teaser for this exact input WITHOUT running the handler —
      // the preview path runs the full handler (real upstream cost, zero
      // revenue), so a repeat preview must not re-hit upstreams.
      const cached = await loadPreview(service.id, params);
      if (cached) {
        await logUsage(service.id, false, srcHash(ip), req.headers.get("user-agent") || "", req.headers.get("referer") || "", false, true);
        return previewBody(cached);
      }

      // Cache miss → we must run the handler. Tight per-IP limit here (well below
      // the outer 60/min) so this cost path can't be scraped across many inputs.
      const pl = await rateLimitKv(`preview:${ip}`, 12, 60);
      if (!pl.ok) {
        return NextResponse.json(
          { service: service.id, error: "Free preview limit reached — pay for the full report or retry later.", price: service.price, retryAfterMs: pl.retryAfterMs },
          { status: 429, headers: { "retry-after": String(Math.ceil(pl.retryAfterMs / 1000)) } },
        );
      }
      try {
        const full = await service.handler(params);
        await saveSample(service.id, full);
        const preview = toPreview(full);
        await savePreview(service.id, params, preview);
        await logUsage(service.id, false, srcHash(ip), req.headers.get("user-agent") || "", req.headers.get("referer") || "", false, true);
        return previewBody(preview);
      } catch (err) {
        return handlerErrorResponse(err);
      }
    }
  }

  // The business logic that runs once payment is verified. Handler errors are
  // mapped to an honest 400/502/500 HERE (a >=400 response means withX402 does
  // NOT settle — the buyer is never charged for an error). Without this, any
  // data error (e.g. a token with no DEX pairs) escaped to the outer catch and
  // surfaced as a misleading blanket 503 "payment failed".
  const handler = async (request: NextRequest) => {
    let data: unknown;
    try {
      const p = paramsFrom(request, service);
      data = withBaseReceipt(await service.handler(p), service.id, p);
    } catch (err) {
      return handlerErrorResponse(err);
    }
    await saveSample(service.id, data);
    // A settled call is what keeps this resource inside the discovery index's
    // rolling window, so a real customer payment does the job the index-refresh
    // cron would otherwise pay for. Marking it here is what makes that cron's
    // bill fall as demand rises instead of staying flat.
    await kvSet(indexFreshKey(service.id), "1", INDEX_FRESH_SECONDS);
    // Lowercase before hashing: the payers dashboard hashes the lowercased
    // address from CDP SQL — a checksummed hash here would never match it.
    const payer = payerFromHeaders(request.headers);
    await logUsage(service.id, true, srcHash(clientIp(request)), request.headers.get("user-agent") || "", request.headers.get("referer") || "", false, false, false, payer ? srcHash(payer) : "");
    // buy-credits settles at the CHOSEN tier, not the listed price — record the
    // real cents so the revenue dashboard doesn't count every pack as $5.
    if (service.id === "buy-credits") {
      const cents = Math.round((parseFloat(tierPrice(paramsFrom(request, service).tier || "").replace(/[^0-9.]/g, "")) || 0) * 100);
      if (cents > 0) await kvIncrBy("usage:revenue-cents:buy-credits", cents);
      // Index the balance against the wallet that paid. The token is shown once
      // and only its hash is stored, so without this a buyer who didn't copy it
      // has paid for something unusable with no way back. /api/credits/recover
      // turns this index into a door that only that wallet can open.
      const minted = (data as { creditToken?: unknown })?.creditToken;
      if (payer && typeof minted === "string") await linkCreditOwner(payer, minted);
      // Tell the buyer whether recovery is actually armed for them. Silence here
      // is what made a broken index look like a working feature: the promise
      // "you can recover this with your wallet" is only true if we managed to
      // read the payer, and only the buyer can act on it being false.
      if (data && typeof data === "object") {
        (data as Record<string, unknown>).recovery = payer
          ? {
              armed: true,
              wallet: payer,
              how: "Lost the token? POST /api/credits/recover with a signature from this wallet, or use the form at /credits.",
            }
          : {
              armed: false,
              reason:
                "The paying wallet could not be read from this request, so this balance is NOT recoverable. Save the token now — it cannot be reissued.",
            };
      }
    }
    // A wallet that keeps coming back is the closest thing we have to a
    // customer we can talk to, and the response body is the only channel that
    // reaches whoever runs it. Once, after several paid calls, and only with
    // things that cost them less per unit.
    if (payer && data && typeof data === "object") {
      const back = await returningCallerNote(service.id, srcHash(payer), getSiteUrl());
      if (back) (data as Record<string, unknown>).returningCaller = back;
    }
    await attachRetention(service.id, data, srcHash(clientIp(request)));
    return NextResponse.json(
      withRelated(
        {
          service: service.id,
          builderCode: cfg.appBuilderCode,
          data,
        },
        service.id,
      ),
    );
  };

  const inputSchema =
    service.params.length > 0
      ? {
          type: "object",
          properties: Object.fromEntries(
            service.params.map((p) => [p.name, { type: "string", description: p.label }]),
          ),
          required: service.params.filter((p) => p.required).map((p) => p.name),
        }
      : undefined;

  // Rich discovery metadata feeds CDP Bazaar's hybrid (text + semantic) ranking:
  // a concrete example input and a real example output ("metadata quality") lift
  // us in search results and help the facilitator index the endpoint at all.
  // - input: a call an agent can actually run (see discovery-examples)
  // - output.example: the last real response preview from KV, and when there is
  //   none — which is the case for every endpoint too quiet to have served one
  //   recently, i.e. exactly those needing a shop window — a real response
  //   captured into source instead of nothing at all.
  const exampleInput = exampleInputFor(service);
  const outputExample = (await loadSample(service.id)) ?? staticOutputExample(service.id);

  // Tier packs, mode pricing and coupon discounts all live in one place now, so
  // the challenge and the credit debit cannot disagree. See effectivePriceFor.
  const effectivePrice = await effectivePriceFor(service, req);

  const routeConfig: RouteConfig = {
    accepts: {
      scheme: "exact",
      price: effectivePrice,
      network: NETWORK,
      payTo: cfg.payTo,
    },
    // Canonical resource URL: keeps discovery/Bazaar indexing on the real domain
    // even when the route is reached via the vercel.app host (Cloudflare bypass).
    resource: `${(process.env.NEXT_PUBLIC_SITE_URL || "https://402.com.tr").replace(/\/$/, "")}/api/x402/${service.id}`,
    description: service.description,
    mimeType: "application/json",
    serviceName: service.name,
    tags: tagsFor(service),
    extensions: {
      // Builder Code → lands in settlement calldata as `a`.
      [BUILDER_CODE]: declareBuilderCodeExtension(cfg.appBuilderCode),
      // Discovery → auto-indexed in the x402 Bazaar after settlement.
      ...declareDiscoveryExtension({
        ...(inputSchema ? { inputSchema } : {}),
        ...(exampleInput ? { input: exampleInput } : {}),
        ...(outputExample ? { output: { example: outputExample } } : {}),
      }),
    },
  };

  try {
    const server = await getResourceServer();
    // `false` = do not re-handshake the facilitator. getResourceServer() has
    // already done it once for this instance; letting the wrapper do it per
    // request clears the shared supported-kinds map mid-flight and 503s any
    // concurrent call. See src/lib/x402-server.ts.
    const guarded = withX402(handler, routeConfig, server, undefined, undefined, false);
    const res = await guarded(req);
    // Telemetry: a 402 means the caller was shown the price and (usually) walked
    // away — log it so we can measure challenge→paid conversion per service.
    if (res.status === 402) {
      await logUsage(service.id, false, srcHash(clientIp(req)), req.headers.get("user-agent") || "", req.headers.get("referer") || "", false, false, true);
      // A 402 on a request that DID carry a payment is a verify/settle FAILURE, not
      // a plain challenge — surface the facilitator's real error instead of masking
      // it with the credit-path upsell, which would mislead a caller who just paid.
      if (hasPayment) {
        const raw = await res.clone().text();
        console.error(`[x402 verify-fail] ${service.id}: ${raw.slice(0, 500)}`);
        return res;
      }
      // Make the challenge sell, not just charge: show a preview of a real recent
      // response (cached at serve time — never computed here, an unpaid handler
      // run would be a cost-drain vector) plus the no-wallet payment path. Extra
      // top-level fields are spec-safe; x402 clients only read `accepts`.
      try {
        const body = (await res.clone().json()) as Record<string, unknown>;
        const sample = (await loadSample(service.id)) ?? staticOutputExample(service.id);
        if (sample) {
          body.sample = {
            note: "Preview of a real response — a paid call returns the full report (all signals, details & recommendation).",
            data: sample,
          };
        }
        if (freeEligible) {
          body.freeCall =
            "This service gives 1 free call/day per IP — retry with `?free=1` (or the header `x-402-free: 1`) and no payment header. After that the same flag returns a preview.";
        }
        // The text-in AI services get 1000+ price-probes each — show the probing
        // agent a concrete input→output pair (static, zero AI cost) so it can
        // see the exact value before paying. The generic `sample` above only
        // shows an output; for text-transform tools the PAIR is what sells.
        const example = CHALLENGE_EXAMPLES[service.id];
        if (example) body.example = example;
        body.prepaidCredits =
          "One x402 settlement on /api/x402/buy-credits?tier=0.25|1|5|20 mints a bearer credit token; send it as the x-credit-token header and later calls debit the balance — no wallet or signature per call after that first purchase.";
        // Machine-readable on-ramps (x402 clients read `accepts` and stop; this
        // gives an AGENT a structured, cheaper path it can act on programmatically
        // instead of the prose above). Starter credit is first: one $0.25
        // settlement converts a wallet-less caller into a retained customer with a
        // stored balance — the lowest-friction way in.
        const origin = getSiteUrl();
        const alternatives: Array<Record<string, unknown>> = [
          {
            action: "buy-credits",
            recommended: true,
            method: "POST",
            url: `${origin}/api/x402/buy-credits?tier=0.25`,
            priceUsdc: "0.25",
            then: "Send the returned token as the `x-credit-token` header on this and any paid call; each debits its price from the balance — no per-call signature.",
            gives: "≈8 calls at this service's price from one settlement; lowest-friction start.",
          },
        ];
        if (freeEligible) {
          alternatives.push({
            action: "free-call",
            method: "GET",
            url: `${req.url}${req.url.includes("?") ? "&" : "?"}free=1`,
            gives: "1 free full call/day per IP — repeat this request with free=1 (or the header x-402-free: 1) and no payment header.",
          });
        }
        alternatives.push({ action: "pay-x402", method: "GET", url: req.url, gives: "Pay this exact call now over x402 — see the `accepts` array for scheme/amount/asset/payTo." });
        body.alternatives = alternatives;
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        fixRouteTemplate(headers);
        return NextResponse.json(body, { status: 402, headers });
      } catch {
        return res; // enrichment is best-effort — never break the challenge itself
      }
    }
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Server misconfigured";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

/**
 * Same endpoint, with the inputs in a JSON body.
 *
 * Everything here reads its parameters from the query string, which is fine for
 * an address or a token but cannot carry a document: `file-publish` takes a
 * whole report, and a URL is the wrong place for one. So a POST body is folded
 * into the query string and handed to the identical GET path — one code path for
 * payment, free tier, credits and telemetry, rather than a second one to keep in
 * step. Query parameters win, so an explicit `?x=` is never overridden by a body.
 *
 * The payment is unaffected: `accepts.resource` is the canonical service URL
 * without any query string, so rewriting the query cannot invalidate a signature.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ service: string }> }) {
  const { service: serviceId } = await ctx.params;
  const service = getService(serviceId);
  if (!service) {
    return NextResponse.json({ error: `Unknown service: ${serviceId}` }, { status: 404 });
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    if (raw.trim()) body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON (or send the parameters in the query string)" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object of parameters" }, { status: 400 });
  }

  const url = new URL(req.url);
  for (const p of service.params) {
    if (url.searchParams.has(p.name)) continue;
    const v = body[p.name];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      url.searchParams.set(p.name, String(v));
    }
  }

  // Forwarded as a GET with the original headers — the payment header, the
  // credit token and the force flag all have to survive the hand-off.
  const headers = new Headers(req.headers);
  headers.delete("content-type");
  headers.delete("content-length");
  return GET(new NextRequest(url, { method: "GET", headers }), ctx);
}
