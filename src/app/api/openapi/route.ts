/** OpenAPI 3.1 spec of the paid endpoints — for agents/tools that import APIs. Served at /openapi.json. */

import { SERVICES } from "@/lib/services";
import { getConfig, getSiteUrl } from "@/lib/config";
import { nearCreditsOn } from "@/lib/near-funding";
import { openApi200For } from "@/lib/morpho-health-output-contract";

export const dynamic = "force-dynamic";

export function GET() {
  const site = getSiteUrl();
  const cfg = getConfig();

  const paths: Record<string, unknown> = {};
  for (const s of SERVICES.filter((x) => !x.hidden)) {
    paths[`/api/x402/${s.id}`] = {
      get: {
        tags: [s.category || "Utility"],
        operationId: s.id.replace(/-/g, "_"),
        summary: s.name,
        description: `${s.description} Paid via x402: ${s.price} in USDC on Base (eip155:8453) to ${cfg.payTo}. Returns 402 with payment requirements; pay and retry.`,
        "x-openai-isConsequential": s.id === "buy-credits",
        parameters: s.params.map((p) => ({
          name: p.name,
          in: "query",
          required: Boolean(p.required),
          description: p.label,
          schema: { type: "string" },
        })),
        responses: {
          "200": openApi200For(s.id),
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

  // Platform endpoints that are not single paid services. Prepaid-credit paths
  // take the token in the x-credit-token header, never the URL.
  const creditHeader = { name: "x-credit-token", in: "header", required: true, schema: { type: "string" }, description: "Prepaid credit token (ck_…)" };
  paths["/api/workflows"] = {
    get: {
      operationId: "workflows_list",
      summary: "Workflow templates and their quotes",
      description: "Lists built-in multi-step templates (e.g. pre-buy: token-risk → sellability → swap-route). Add template=<id>&quote=1 plus the template's inputs to price one run.",
      parameters: [
        { name: "template", in: "query", schema: { type: "string" } },
        { name: "quote", in: "query", schema: { type: "string", enum: ["1"] } },
      ],
      responses: { "200": { description: "Templates with steps, inputs and quoted price" } },
    },
  };
  paths["/api/workflows/run"] = {
    post: {
      operationId: "workflows_run",
      summary: "Run up to 5 paid services in one request, paid from a credit token",
      description:
        "Each step is a normal paid call debited from the credit token; a failed step is refunded, and steps after a failure, an empty balance or a STOP decision (stopOnStop, default on) are neither called nor charged. Refused up front if the balance is below the quote. Params may reference earlier answers, e.g. \"$1.data.address\".",
      parameters: [creditHeader],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                template: { type: "string" },
                input: { type: "object", additionalProperties: { type: "string" } },
                steps: { type: "array", maxItems: 5, items: { type: "object", required: ["service"], properties: { service: { type: "string" }, params: { type: "object" } } } },
                stopOnStop: { type: "boolean", default: true },
                dryRun: { type: "boolean", default: false },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Per-step status, chargedUsd, decision and output; completed:false with haltReason when a run stops early" },
        "400": { description: "Invalid steps, params or references — nothing charged" },
        "402": { description: "Missing/invalid token or balance below the quote — nothing charged" },
      },
    },
  };
  paths["/api/credits/fleet"] = {
    get: {
      operationId: "fleet_list",
      summary: "List child tokens of a credit token, with today's spend",
      parameters: [creditHeader],
      responses: { "200": { description: "Children with label, status, caps and spentTodayUsd" }, "401": { description: "Missing or unknown parent token" } },
    },
    post: {
      operationId: "fleet_create",
      summary: "Create a child token that spends from the parent balance under a daily cap",
      description: "No new money is minted. The child token is returned once. Paused, capped, over-max or not-allowed calls get 403 and are not charged.",
      parameters: [creditHeader],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["label", "dailyCapUsd"],
              properties: {
                label: { type: "string" },
                dailyCapUsd: { type: "number" },
                perCallMaxUsd: { type: "number" },
                allow: { type: "array", items: { type: "string" }, description: "Service ids this child may call" },
              },
            },
          },
        },
      },
      responses: { "201": { description: "Child created; childToken shown once" }, "400": { description: "Invalid input" }, "401": { description: "Missing or unknown parent token" } },
    },
  };
  paths["/api/credits/fleet/{id}"] = {
    patch: {
      operationId: "fleet_set_status",
      summary: "Pause or resume a child token (takes effect on its next call)",
      parameters: [creditHeader, { name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["paused", "active"] } } } } } },
      responses: { "200": { description: "Updated" }, "404": { description: "No such child for this parent" } },
    },
    delete: {
      operationId: "fleet_delete",
      summary: "Delete a child token",
      parameters: [creditHeader, { name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": { description: "Deleted" }, "404": { description: "No such child for this parent" } },
    },
  };
  paths["/api/radar"] = {
    get: {
      operationId: "radar",
      summary: "Cross-DEX spreads for liquid Base tokens and alerts that actually fired (free)",
      responses: { "200": { description: "spreads.rows (no_data where a token could not be read) and recently fired alerts" } },
    },
  };
  paths["/api/scout/latest"] = {
    get: {
      operationId: "scout_latest",
      summary: "Latest automated scans of new Base tokens (free)",
      description: "What our scan computed for each new token (flags, level, sources answered/missing), with a re-check link. A row is a scan result at a point in time, not a verdict that a token is a scam.",
      parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 } }],
      responses: { "200": { description: "scans[]" }, "429": { description: "Rate limited" } },
    },
  };
  paths["/api/leaderboard"] = {
    get: {
      operationId: "leaderboard",
      summary: "Services ranked by paid calls from outside payers (free)",
      description: "Counted at settlement with our own purchases excluded. Counts only — no revenue, no addresses.",
      responses: { "200": { description: "since, externalCalls, distinctPayers, services[]" } },
    },
  };
  paths["/api/events/live"] = {
    get: {
      operationId: "events_live",
      summary: "Server-sent events: recorded outside paid calls and alert firings",
      description: "Closes after 55 seconds; reconnect with Last-Event-ID. Only recorded events are sent.",
      responses: { "200": { description: "text/event-stream", content: { "text/event-stream": {} } } },
    },
  };

  return Response.json(
    {
      openapi: "3.1.0",
      info: {
        title: "x402 Bazaar",
        version: "1.0.0",
        description:
          "Pay-per-call APIs for agents on Base and NEAR via the x402 protocol (settled in USDC on Base; credits can be bought from NEAR). Each endpoint returns HTTP 402 with payment requirements; an x402 client pays a USDC micro-payment and retries.",
      },
      servers: [{ url: site }],
      paths,
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
