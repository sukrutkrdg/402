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
import { getResourceServer } from "@/lib/x402-server";
import { getService } from "@/lib/services";
import { NETWORK, getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ service: string }> }) {
  const { service: serviceId } = await ctx.params;
  const service = getService(serviceId);
  if (!service) {
    return NextResponse.json({ error: `Unknown service: ${serviceId}` }, { status: 404 });
  }

  const cfg = getConfig();

  // The business logic that runs once payment is verified.
  const handler = async (request: NextRequest) => {
    const url = new URL(request.url);
    const params: Record<string, string> = {};
    for (const p of service.params) {
      const v = url.searchParams.get(p.name);
      if (v) params[p.name] = v;
    }
    const data = await service.handler(params);
    return NextResponse.json({
      service: service.id,
      builderCode: cfg.appBuilderCode,
      data,
    });
  };

  const routeConfig: RouteConfig = {
    accepts: {
      scheme: "exact",
      price: service.price,
      network: NETWORK,
      payTo: cfg.payTo,
    },
    description: service.description,
    mimeType: "application/json",
    // Declare our Builder Code so it lands in the settlement calldata as `a`.
    extensions: {
      [BUILDER_CODE]: declareBuilderCodeExtension(cfg.appBuilderCode),
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
