/** OpenAPI 3.1 spec of the paid endpoints — for agents/tools that import APIs. Served at /openapi.json. */

import { SERVICES } from "@/lib/services";
import { getConfig, getSiteUrl } from "@/lib/config";
import { nearCreditsOn } from "@/lib/near-funding";

export const dynamic = "force-dynamic";

export function GET() {
  const site = getSiteUrl();
  const cfg = getConfig();

  const paths: Record<string, unknown> = {};
  for (const s of SERVICES.filter((x) => !x.hidden)) {
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

  // Buying credits from NEAR: not x402, so it is described as plain JSON
  // endpoints — the credit token they return works on every path above.
  if (nearCreditsOn()) {
    paths["/api/credits/near/quote"] = {
      post: {
        operationId: "near_credits_quote",
        summary: "Buy prepaid credits with NEAR Intents",
        description:
          "Creates an order: pay the returned amountIn of originAsset (any asset NEAR Intents routes — USDC/USDT/NEAR on NEAR, BTC, SOL, …) to depositAddress, then poll near_credits_status. Swap cost is on the payer (EXACT_OUTPUT).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tier", "originAsset", "refundTo"],
                properties: {
                  tier: { type: "string", enum: ["0.25", "1", "5", "20"] },
                  originAsset: { type: "string", description: "1Click asset id, e.g. nep141:wrap.near — list: https://1click.chaindefuser.com/v0/tokens" },
                  refundTo: { type: "string", description: "Your address/account on the origin chain (64-hex NEAR implicit accounts take no .near suffix)" },
                  depositType: { type: "string", enum: ["ORIGIN_CHAIN", "INTENTS"] },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Order created — orderId, orderSecret (shown once), pay.depositAddress, pay.amountIn" },
          "400": { description: "Bad input (tier, asset id, refund address) — nothing was created" },
          "503": { description: "Temporarily unavailable — nothing was charged" },
        },
      },
    };
    paths["/api/credits/near/status"] = {
      get: {
        operationId: "near_credits_status",
        summary: "Status of a NEAR credit order; the credit token on SUCCESS",
        parameters: [
          { name: "orderId", in: "query", required: true, schema: { type: "string" } },
          { name: "x-order-secret", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "status: PENDING_DEPOSIT | KNOWN_DEPOSIT_TX | PROCESSING | SUCCESS (with creditToken) | REFUNDED | FAILED" },
          "404": { description: "Unknown order or wrong secret" },
        },
      },
    };
  }

  return Response.json(
    {
      openapi: "3.1.0",
      info: {
        title: "x402 Bazaar",
        version: "1.0.0",
        description:
          "Pay-per-call APIs on Base via the x402 protocol. Each endpoint returns HTTP 402 with payment requirements; an x402 client pays a USDC micro-payment and retries.",
      },
      servers: [{ url: site }],
      paths,
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
