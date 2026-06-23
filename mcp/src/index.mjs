#!/usr/bin/env node
/**
 * x402-bazaar-mcp
 *
 * An MCP (Model Context Protocol) stdio server that auto-discovers every paid
 * endpoint in the x402 Bazaar catalog and registers each one as an MCP tool.
 * When a tool is called the server transparently handles the x402 payment flow
 * (HTTP 402 → pay USDC on Base → retry), so the AI agent calling the tool
 * never has to deal with payment details itself.
 *
 * Required env:
 *   AGENT_PRIVATE_KEY  – hex private key of a Base wallet that holds USDC
 *                        (prefix 0x is optional; will be added if missing)
 *
 * Optional env:
 *   X402_BAZAAR_CATALOG – catalog URL (default: https://402.com.tr/api/catalog)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

// ---------------------------------------------------------------------------
// 1. Config + lazy paying-fetch
// ---------------------------------------------------------------------------
// The private key is needed only to PAY for a tool call — not to start the
// server. Building it lazily lets the server boot, advertise its tools, and be
// scanned by registries (Smithery, etc.) without a key. The key is required
// only when a tool is actually invoked.

const CATALOG_URL =
  process.env.X402_BAZAAR_CATALOG ?? "https://402.com.tr/api/catalog";

let _payingFetch = null;
function getPayingFetch() {
  if (_payingFetch) return _payingFetch;
  const rawKey = process.env.AGENT_PRIVATE_KEY;
  if (!rawKey) {
    throw new Error(
      "AGENT_PRIVATE_KEY is not set — required to pay for tool calls. Add it to your MCP client config."
    );
  }
  const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  const account = privateKeyToAccount(privateKey);
  const client = new x402Client();
  client.register("eip155:8453", new ExactEvmScheme(account));
  _payingFetch = wrapFetchWithPayment(fetch, client);
  return _payingFetch;
}

// ---------------------------------------------------------------------------
// 2. Create the MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "x402-bazaar",
  version: "0.1.4",
});

// ---------------------------------------------------------------------------
// 3. Fetch the catalog and register one MCP tool per service
// ---------------------------------------------------------------------------
// Non-fatal: if the catalog is unreachable the server still starts (with zero
// tools) so it can be connected to and scanned by registries.

let services = [];
try {
  const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10000) });
  if (res.ok) {
    const catalog = await res.json();
    services = catalog.services ?? catalog ?? [];
  } else {
    process.stderr.write(`[x402-bazaar-mcp] WARN: catalog HTTP ${res.status}\n`);
  }
} catch (err) {
  process.stderr.write(`[x402-bazaar-mcp] WARN: catalog fetch failed: ${err.message}\n`);
}
if (!Array.isArray(services)) services = [];

const registeredNames = new Set();
for (const service of services) {
  // MCP tool names must use underscores (not dashes).
  const toolName = (service.id ?? service.name ?? "unknown").replace(/-/g, "_");

  // Guard against duplicate tool names (would overwrite/break registration).
  if (registeredNames.has(toolName)) {
    process.stderr.write(`[x402-bazaar-mcp] WARN: duplicate tool name "${toolName}" — skipping\n`);
    continue;
  }
  registeredNames.add(toolName);

  // Build a zod schema for each input key. The catalog's service.input entries
  // carry { type, required, description } — honor `required` so the agent knows
  // which params are mandatory (required → non-optional string, else optional).
  const inputShape = {};
  const inputDef = service.input ?? {};
  for (const key of Object.keys(inputDef)) {
    const def = inputDef[key] ?? {};
    const desc = (typeof def === "object" ? def.description : def) ?? key;
    const base = z.string().describe(typeof desc === "string" ? desc : key);
    inputShape[key] = def && def.required ? base : base.optional();
  }

  const description =
    service.description ??
    `Call the ${service.name ?? service.id} endpoint (paid via x402 on Base).`;

  // Register the tool with McpServer.
  // Signature: server.tool(name, description, zodShape, handler)
  server.tool(toolName, description, inputShape, async (args) => {
    // Build the URL from the service's endpoint and append provided query params.
    const url = new URL(service.endpoint);
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }

    // Call the endpoint; x402 payment is handled transparently.
    let response;
    try {
      response = await getPayingFetch()(url.toString());
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `[x402-bazaar-mcp] Request failed: ${err.message}`,
          },
        ],
        isError: true,
      };
    }

    const text = await response.text();

    if (!response.ok) {
      return {
        content: [{ type: "text", text }],
        isError: true,
      };
    }

    return { content: [{ type: "text", text }] };
  });

  process.stderr.write(`[x402-bazaar-mcp] Registered tool: ${toolName}\n`);
}

// ---------------------------------------------------------------------------
// 5. Connect via stdio transport (standard MCP pattern)
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(
  `[x402-bazaar-mcp] Server ready — ${services.length} tool(s) registered.\n`
);
