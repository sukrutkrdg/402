/** OpenAPI 3.1 spec of the paid endpoints — for agents/tools that import APIs. Served at /openapi.json. */

import { SERVICES } from "@/lib/services";
import { getConfig, getSiteUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

export function GET() {
  const site = getSiteUrl();
  const cfg = getConfig();

  const paths: Record<string, unknown> = {};
  for (const s of SERVICES) {
    paths[`/api/x402/${s.id}`] = {
      get: {
        operationId: s.id.replace(/-/g, "_"),
        summary: s.name,
        description: `${s.description} Paid via x402: ${s.price} in USDC on Base (eip155:8453) to ${cfg.payTo}. Returns 402 with payment requirements; pay and retry.`,
        parameters: s.params.map((p) => ({
          name: p.name,
          in: "query",
          required: Boolean(p.required),
          description: p.label,
          schema: { type: "string" },
        })),
        responses: {
          "200": {
            description: "Success",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "402": { description: "Payment Required — pay via x402 and retry" },
        },
        "x-x402": { price: s.price, network: "eip155:8453", asset: "USDC", payTo: cfg.payTo || null },
      },
    };
  }

  return Response.json({
    openapi: "3.1.0",
    info: {
      title: "x402 Bazaar",
      version: "1.0.0",
      description:
        "Pay-per-call APIs on Base via the x402 protocol. Each endpoint returns HTTP 402 with payment requirements; an x402 client pays a USDC micro-payment and retries.",
    },
    servers: [{ url: site }],
    paths,
  });
}
