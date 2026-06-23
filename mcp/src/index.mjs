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
// 1. Validate environment
// ---------------------------------------------------------------------------

const rawKey = process.env.AGENT_PRIVATE_KEY;
if (!rawKey) {
  process.stderr.write(
    "[x402-bazaar-mcp] ERROR: AGENT_PRIVATE_KEY is not set.\n" +
      "  Export a hex private key for a Base wallet that holds USDC.\n" +
      "  Example: export AGENT_PRIVATE_KEY=0xabc123...\n"
  );
  process.exit(1);
}

// Normalise: add 0x prefix if the user omitted it
const privateKey = /** @type {`0x${string}`} */ (
  rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`
);

const CATALOG_URL =
  process.env.X402_BAZAAR_CATALOG ?? "https://402.com.tr/api/catalog";

// ---------------------------------------------------------------------------
// 2. Build x402 paying-fetch
// ---------------------------------------------------------------------------

// Create a viem account from the private key.
const account = privateKeyToAccount(privateKey);

// Register the account with the x402 client on Base mainnet (chain id 8453).
const client = new x402Client();
client.register("eip155:8453", new ExactEvmScheme(account));

// Wrap the global fetch so every request that gets a 402 response is
// automatically paid and retried — the caller sees only the final response.
const payingFetch = wrapFetchWithPayment(fetch, client);

// ---------------------------------------------------------------------------
// 3. Create the MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "x402-bazaar",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// 4. Fetch the catalog and register one MCP tool per service
// ---------------------------------------------------------------------------

let catalog;
try {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  catalog = await res.json();
} catch (err) {
  process.stderr.write(
    `[x402-bazaar-mcp] ERROR: Could not fetch catalog from ${CATALOG_URL}: ${err.message}\n`
  );
  process.exit(1);
}

// The catalog is expected to have a "services" array.
const services = catalog.services ?? catalog;
if (!Array.isArray(services) || services.length === 0) {
  process.stderr.write(
    "[x402-bazaar-mcp] WARNING: Catalog returned no services. No tools will be registered.\n"
  );
}

for (const service of services) {
  // MCP tool names must use underscores (not dashes).
  const toolName = (service.id ?? service.name ?? "unknown").replace(/-/g, "_");

  // Build a zod schema for each known input key.
  // The catalog's service.input is an object whose keys are param names.
  // We register every param as an optional z.string() — agents may fill in
  // whatever subset they know about.
  const inputShape = {};
  const inputDef = service.input ?? {};
  for (const key of Object.keys(inputDef)) {
    // Mark params as optional so the tool can still be called with partial args.
    inputShape[key] = z.string().optional().describe(
      inputDef[key]?.description ?? inputDef[key] ?? key
    );
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
      response = await payingFetch(url.toString());
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
