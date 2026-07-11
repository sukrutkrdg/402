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
import { NETWORK, getConfig } from "@/lib/config";
import { consumeFree } from "@/lib/free-tier";
import { toPreview } from "@/lib/preview";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";
import { logUsage, srcHash } from "@/lib/usage";
import { kvGet, kvSet, kvDel } from "@/lib/kv";
import { debitCredit, refundCredit, tierPrice } from "@/lib/credits";
import { sinceLastCheck } from "@/lib/since-last";

/** Service price string ("$0.03") → integer cents (3). */
function priceCents(price: string): number {
  return Math.round((parseFloat(price.replace(/[^0-9.]/g, "")) || 0) * 100);
}

/** Best-effort payer wallet from the x-payment header (base64 JSON) — used only
 * for anonymized repeat-buyer analytics; never throws. */
function payerFrom(request: NextRequest): string {
  try {
    const h = request.headers.get("x-payment");
    if (!h) return "";
    const j = JSON.parse(Buffer.from(h, "base64").toString("utf8")) as Record<string, unknown>;
    const dig = (o: unknown): string => {
      if (!o || typeof o !== "object") return "";
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (/^(from|payer|sender)$/i.test(k) && typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return v;
        if (v && typeof v === "object") { const r = dig(v); if (r) return r; }
      }
      return "";
    };
    return dig(j);
  } catch {
    return "";
  }
}

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
    // Defensive ceiling — handlers clamp their own params, but never allocate
    // oversized values. No legitimate param here exceeds 2000 chars.
    if (v) params[p.name] = v.slice(0, 2000);
  }
  return params;
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
    /provide|missing|valid|invalid|required|no .*found|no .*data|no .*available|no price/.test(m)
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
  const internalHeader = req.headers.get("x-warden-internal");
  if (cfg.internalSecret && internalHeader && secretMatches(internalHeader, cfg.internalSecret)) {
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
    const cents = priceCents(service.price);
    // Debit FIRST (atomic DECRBY, fail-closed): this both charges and reserves in
    // one step, so two concurrent calls can't each pass a cheap pre-check and get a
    // free call on the race. An underfunded/unknown token is refunded inside
    // debitCredit and reported here.
    const debit = await debitCredit(creditToken, cents);
    if (!debit.ok) {
      return NextResponse.json(
        {
          error: debit.reason === "insufficient" ? "Insufficient credits" : "Invalid or unusable credit token",
          service: service.id,
          priceUsd: +(cents / 100).toFixed(2),
          balanceUsd: +((debit.balance ?? 0) / 100).toFixed(2),
          topUp: "Buy more at /api/x402/buy-credits (tier=1|5|20), or omit x-credit-token to pay per-call via x402.",
        },
        { status: 402 },
      );
    }
    let data: unknown;
    try {
      data = await service.handler(paramsFrom(req, service));
    } catch (err) {
      await refundCredit(creditToken, cents); // charged but never delivered → give it back
      return handlerErrorResponse(err);
    }
    const ip = clientIp(req);
    await logUsage(service.id, true, srcHash(ip), req.headers.get("user-agent") || "", req.headers.get("referer") || "", false, false, false, srcHash(`credit:${creditToken}`));
    return NextResponse.json(
      { service: service.id, builderCode: cfg.appBuilderCode, data, paidVia: "credits", creditBalanceUsd: +(debit.remaining / 100).toFixed(2) },
      { headers: { "x-credit-balance": String(debit.remaining), "x-paid-via": "credits" } },
    );
  }

  // Free tier: an unpaid request (no payment header) that isn't the internal
  // demo buy flow gets one free trial call/day per IP, then must pay. This is the
  // agent trial funnel.
  const hasPayment = Boolean(req.headers.get("x-payment") || req.headers.get("payment-signature"));
  const forcePay = req.headers.get("x-x402-force") === "1";
  // AI services have real upstream cost (Claude) — never give them away on the
  // free tier (the in-memory counter resets per serverless instance, so free
  // AI calls could run up the owner's bill). Cheap RPC services stay free-eligible.
  const freeEligible = service.category !== "AI" && !service.noFreeTier;
  if (!hasPayment && !forcePay && freeEligible) {
    const ip = clientIp(req);
    const free = await consumeFree(`free:${ip}`);
    if (free.allowed) {
      try {
        const data = await service.handler(paramsFrom(req, service));
        await logUsage(service.id, false, srcHash(ip), req.headers.get("user-agent") || "", req.headers.get("referer") || "");
        return NextResponse.json(
          { service: service.id, builderCode: cfg.appBuilderCode, data, freeTier: true, freeRemaining: free.remaining },
          { headers: { "x-free-tier": "true", "x-free-remaining": String(free.remaining) } },
        );
      } catch (err) {
        return handlerErrorResponse(err);
      }
    } else {
      // Daily free full report already used → return a PREVIEW (headline scalars +
      // "N signals found") instead of a hard 402 wall. The teaser creates the
      // pull; the full detail is what a paid call unlocks. Rate-limited above, so
      // it can't be scraped for free at scale; AI/metered services aren't
      // free-eligible so they never reach here.
      try {
        const full = await service.handler(paramsFrom(req, service));
        await logUsage(service.id, false, srcHash(ip), req.headers.get("user-agent") || "", req.headers.get("referer") || "", false, true);
        return NextResponse.json(
          {
            service: service.id,
            builderCode: cfg.appBuilderCode,
            data: toPreview(full),
            preview: true,
            unlock: `Free daily check used — this is a preview. Pay ${service.price} for the full report (all signals, details & recommendation).`,
          },
          { headers: { "x-preview": "true" } },
        );
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
      data = await service.handler(paramsFrom(request, service));
    } catch (err) {
      return handlerErrorResponse(err);
    }
    const payer = payerFrom(request);
    await logUsage(service.id, true, srcHash(clientIp(request)), request.headers.get("user-agent") || "", request.headers.get("referer") || "", false, false, false, payer ? srcHash(payer) : "");
    // Funnel coupon: paying the entry check (token-risk/rug-score) discounts the
    // AI report on the SAME token for 1h; redeeming it consumes the coupon.
    try {
      const d = data as Record<string, unknown> | null;
      const addr = String(d?.address ?? "").toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(addr)) {
        const src = srcHash(clientIp(request));
        if (service.id === "token-risk" || service.id === "rug-score") {
          await kvSet(`coupon:${src}:${addr}`, "1", 3600);
          // Retention (R2): attach how this token's risk moved since this caller's
          // last paid check on it — the diff that pulls them back.
          const score = typeof d?.riskScore === "number" ? (d.riskScore as number) : typeof d?.rugScore === "number" ? (d.rugScore as number) : null;
          if (score !== null && d) {
            const level = String(d.riskLevel ?? d.level ?? "");
            const sl = await sinceLastCheck(src, addr, score, level);
            if (sl) d.sinceLastCheck = sl;
          }
        } else if (service.id === "ai-token-report") {
          await kvDel(`coupon:${src}:${addr}`);
        }
      }
    } catch {
      /* coupon/retention bookkeeping is best-effort — never blocks the paid response */
    }
    return NextResponse.json({
      service: service.id,
      builderCode: cfg.appBuilderCode,
      data,
    });
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

  // Coupon-discounted price: a caller who just paid the entry check on this token
  // gets the AI report for less. Checked at challenge time by src+token; falls
  // back to full price if absent — never cheaper without a real prior purchase.
  let effectivePrice = service.price;
  if (service.id === "buy-credits") {
    // The challenge amount is the chosen pack's price (tier=1|5|20).
    effectivePrice = tierPrice(paramsFrom(req, service).tier || "");
  } else if (service.id === "ai-token-report") {
    try {
      const addr = String(paramsFrom(req, service).address ?? "").toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(addr) && (await kvGet(`coupon:${srcHash(clientIp(req))}:${addr}`))) {
        effectivePrice = "$0.05";
      }
    } catch {
      /* fall back to full price */
    }
  }

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
    tags: [service.category.toLowerCase(), "x402", "base"],
    extensions: {
      // Builder Code → lands in settlement calldata as `a`.
      [BUILDER_CODE]: declareBuilderCodeExtension(cfg.appBuilderCode),
      // Discovery → auto-indexed in the x402 Bazaar after settlement.
      ...declareDiscoveryExtension(inputSchema ? { inputSchema } : {}),
    },
  };

  try {
    const server = getResourceServer();
    const guarded = withX402(handler, routeConfig, server);
    const res = await guarded(req);
    // Telemetry: a 402 means the caller was shown the price and (usually) walked
    // away — log it so we can measure challenge→paid conversion per service.
    if (res.status === 402) {
      await logUsage(service.id, false, srcHash(clientIp(req)), req.headers.get("user-agent") || "", req.headers.get("referer") || "", false, false, true);
    }
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Server misconfigured";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
