/**
 * SELLER — the paid marketplace endpoints.
 *
 * A single dynamic route serves every service in the catalog. For each request
 * we look up the service, build its x402 RouteConfig (price + Builder Code app
 * code `a`), and wrap the real handler with `withX402`. `withX402` only settles
 * the payment *after* the handler returns a < 400 response, so buyers never pay
 * for an error.
 */

import { NextRequest, NextResponse } from "next/server";
import { withX402, type RouteConfig } from "@x402/next";
import { BUILDER_CODE, declareBuilderCodeExtension } from "@x402/extensions/builder-code";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { getResourceServer } from "@/lib/x402-server";
import { getService } from "@/lib/services";
import { NETWORK, getConfig } from "@/lib/config";
import { consumeFree } from "@/lib/free-tier";
import { clientIp } from "@/lib/rate-limit";
import { logUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";

function paramsFrom(request: NextRequest, service: ReturnType<typeof getService>) {
  const url = new URL(request.url);
  const params: Record<string, string> = {};
  for (const p of service!.params) {
    const v = url.searchParams.get(p.name);
    if (v) params[p.name] = v;
  }
  return params;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ service: string }> }) {
  const { service: serviceId } = await ctx.params;
  const service = getService(serviceId);
  if (!service) {
    return NextResponse.json({ error: `Unknown service: ${serviceId}` }, { status: 404 });
  }

  const cfg = getConfig();

  // Free tier: an unpaid request (no payment header) that isn't the internal
  // demo buy flow gets a few free calls/day per IP, then must pay. This is the
  // agent trial funnel.
  const hasPayment = Boolean(req.headers.get("x-payment") || req.headers.get("payment-signature"));
  const forcePay = req.headers.get("x-x402-force") === "1";
  // AI services have real upstream cost (Claude) — never give them away on the
  // free tier (the in-memory counter resets per serverless instance, so free
  // AI calls could run up the owner's bill). Cheap RPC services stay free-eligible.
  const freeEligible = service.category !== "AI";
  if (!hasPayment && !forcePay && freeEligible) {
    const ip = clientIp(req);
    const free = await consumeFree(`free:${ip}`);
    if (free.allowed) {
      try {
        const data = await service.handler(paramsFrom(req, service));
        await logUsage(service.id, false);
        return NextResponse.json(
          { service: service.id, builderCode: cfg.appBuilderCode, data, freeTier: true, freeRemaining: free.remaining },
          { headers: { "x-free-tier": "true", "x-free-remaining": String(free.remaining) } },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Service error";
        return NextResponse.json({ error: message }, { status: 502 });
      }
    }
  }

  // The business logic that runs once payment is verified.
  const handler = async (request: NextRequest) => {
    const data = await service.handler(paramsFrom(request, service));
    await logUsage(service.id, true);
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
