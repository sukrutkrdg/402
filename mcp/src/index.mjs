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
// scanned by registries without a key. The key is required only on invocation.

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

const log = (m) => process.stderr.write(`[x402-bazaar-mcp] ${m}\n`);

// ---------------------------------------------------------------------------
// 2. Create the MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "x402-bazaar", version: "0.1.5" });

// ---------------------------------------------------------------------------
// 3. Tool registration (with POST support, typed inputs, pretty JSON output)
// ---------------------------------------------------------------------------

const registeredNames = new Set();

function registerService(service) {
  // MCP tool names must use underscores (not dashes).
  const toolName = (service.id ?? service.name ?? "unknown").replace(/-/g, "_");
  if (registeredNames.has(toolName)) return false; // already registered
  registeredNames.add(toolName);

  // Build a typed zod schema per input key from the catalog's { type, required,
  // description }. Use coercion so an agent can pass strings for number/boolean.
  const inputShape = {};
  const inputDef = service.input ?? {};
  for (const key of Object.keys(inputDef)) {
    const def = inputDef[key] ?? {};
    const t = typeof def === "object" ? def.type : null;
    const desc = (typeof def === "object" ? def.description : def) ?? key;
    let base;
    if (t === "number" || t === "integer") base = z.coerce.number();
    else if (t === "boolean") base = z.coerce.boolean();
    else base = z.string();
    base = base.describe(typeof desc === "string" ? desc : key);
    inputShape[key] = def && def.required ? base : base.optional();
  }

  const description =
    service.description ??
    `Call the ${service.name ?? service.id} endpoint (paid via x402 on Base).`;
  const method = (service.method ?? "GET").toUpperCase();

  server.tool(toolName, description, inputShape, async (args) => {
    let response;
    try {
      const pay = getPayingFetch();
      if (method === "GET") {
        const url = new URL(service.endpoint);
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
        }
        response = await pay(url.toString());
      } else {
        // POST/PUT/etc — send params as a JSON body.
        response = await pay(service.endpoint, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
        });
      }
    } catch (err) {
      let msg = err?.message ?? String(err);
      if (/insufficient|balance|funds|exceeds/i.test(msg)) {
        msg = "Insufficient USDC balance on Base — fund the agent wallet (AGENT_PRIVATE_KEY address).";
      }
      return { content: [{ type: "text", text: `[x402-bazaar-mcp] Request failed: ${msg}` }], isError: true };
    }

    // Pretty-print JSON so the LLM gets a readable, structured result.
    const ct = response.headers.get("content-type") ?? "";
    let text = await response.text();
    if (ct.includes("application/json")) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* leave as-is */
      }
    }

    return { content: [{ type: "text", text }], isError: !response.ok };
  });

  return true;
}

// ---------------------------------------------------------------------------
// 4. Load the catalog (non-fatal) + register tools. Refresh hourly so newly
//    listed services show up without restarting the server.
// ---------------------------------------------------------------------------

async function loadCatalog() {
  let services = [];
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const catalog = await res.json();
      services = catalog.services ?? catalog ?? [];
    } else {
      log(`WARN: catalog HTTP ${res.status}`);
    }
  } catch (err) {
    log(`WARN: catalog fetch failed: ${err.message}`);
  }
  if (!Array.isArray(services)) services = [];

  let added = 0;
  for (const service of services) {
    if (registerService(service)) added++;
  }
  return { total: services.length, added };
}

const { total, added } = await loadCatalog();
log(`Server starting — ${added} tool(s) registered (catalog: ${total}).`);

// Hourly refresh — registers any newly listed services (idempotent via the
// registeredNames set; the SDK emits tools/list_changed for new tools).
setInterval(() => {
  loadCatalog()
    .then(({ added }) => added && log(`Catalog refresh: +${added} new tool(s).`))
    .catch((err) => log(`Catalog refresh failed: ${err.message}`));
}, 60 * 60 * 1000).unref?.();

// ---------------------------------------------------------------------------
// 5. Connect via stdio transport (standard MCP pattern)
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
log(`Server ready — ${registeredNames.size} tool(s).`);
