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
    await logUsage(service.id, true, srcHash(clientIp(request)), request.headers.get("user-agent") || "", request.headers.get("referer") || "");
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

  const routeConfig: RouteConfig = {
    accepts: {
      scheme: "exact",
      price: service.price,
      network: NETWORK,
      payTo: cfg.payTo,
    },
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
    return await guarded(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Server misconfigured";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
