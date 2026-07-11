#!/usr/bin/env node
/**
 * x402-bazaar-mcp
 *
 * An MCP (Model Context Protocol) stdio server that auto-discovers every paid
 * endpoint in the x402 Bazaar catalog and registers each one as an MCP tool.
 *
 * THREE payment modes, in precedence order — the server works with ZERO config
 * (free tier) so an agent can try it instantly, then unlocks paid calls with a
 * prepaid credit token (no wallet, no signing) or a wallet key:
 *
 *   1. X402_CREDIT_TOKEN  – a prepaid credit token (ck_…) from the buy-credits
 *                           service. Sent as the `x-credit-token` header; each
 *                           call debits your balance. No private key, no signing.
 *   2. AGENT_PRIVATE_KEY  – hex private key of a Base wallet holding USDC. Signs
 *                           the x402 payment locally (never sent anywhere).
 *   3. (neither)          – FREE tier: one free full call/day per service, then a
 *                           preview. Zero config — great for trying the tools.
 *
 * Optional env:
 *   X402_BAZAAR_CATALOG – catalog URL (default: https://402.com.tr/api/catalog)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// NOTE: the wallet stack (viem + @x402) is imported LAZILY inside getPayingFetch()
// — free-tier and prepaid-credit callers never load it, so the server boots and
// serves those modes even without the crypto deps present, and startup is lighter.

const VERSION = "0.2.0";

// ---------------------------------------------------------------------------
// 1. Config + payment mode
// ---------------------------------------------------------------------------

const CATALOG_URL =
  process.env.X402_BAZAAR_CATALOG ?? "https://402.com.tr/api/catalog";
const CREDIT_TOKEN = (process.env.X402_CREDIT_TOKEN ?? "").trim();
const HAS_WALLET = Boolean(process.env.AGENT_PRIVATE_KEY);
const MODE = CREDIT_TOKEN ? "credits" : HAS_WALLET ? "wallet" : "free";

// Wallet paying-fetch is built lazily — only needed when actually paying with a
// key. The crypto stack is dynamically imported here so free/credit callers never
// load viem/@x402 at all.
let _payingFetch = null;
async function getPayingFetch() {
  if (_payingFetch) return _payingFetch;
  const [{ x402Client, wrapFetchWithPayment }, { ExactEvmScheme }, { privateKeyToAccount }] =
    await Promise.all([
      import("@x402/fetch"),
      import("@x402/evm/exact/client"),
      import("viem/accounts"),
    ]);
  const rawKey = process.env.AGENT_PRIVATE_KEY;
  const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  const account = privateKeyToAccount(privateKey);
  const client = new x402Client();
  client.register("eip155:8453", new ExactEvmScheme(account));
  _payingFetch = wrapFetchWithPayment(fetch, client);
  return _payingFetch;
}

const log = (m) => process.stderr.write(`[x402-bazaar-mcp] ${m}\n`);

/**
 * Mode-aware fetch. Credits → add the header and use a plain fetch (no signing).
 * Wallet → the x402 paying fetch (auto-handles 402 → pay → retry). Free → plain
 * fetch (the server serves a free daily call / preview, or 402s for paid-only).
 */
async function payAwareFetch(target, opts = {}) {
  if (CREDIT_TOKEN) {
    return fetch(target, {
      ...opts,
      headers: { ...(opts.headers ?? {}), "x-credit-token": CREDIT_TOKEN },
    });
  }
  if (HAS_WALLET) {
    const pay = await getPayingFetch();
    return pay(target, opts);
  }
  return fetch(target, opts);
}

// ---------------------------------------------------------------------------
// 2. Create the MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "x402-bazaar", version: VERSION });

// ---------------------------------------------------------------------------
// 3. Tool registration (typed inputs, mode-aware payment, pretty JSON output)
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
      let target = service.endpoint;
      let opts = {};
      if (method === "GET") {
        const url = new URL(service.endpoint);
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
        }
        target = url.toString();
      } else {
        opts = {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
        };
      }
      response = await payAwareFetch(target, opts);
    } catch (err) {
      let msg = err?.message ?? String(err);
      if (/insufficient|balance|funds|exceeds/i.test(msg)) {
        msg =
          "Insufficient USDC balance on Base — fund the agent wallet (AGENT_PRIVATE_KEY address), or use X402_CREDIT_TOKEN.";
      }
      return {
        content: [{ type: "text", text: `[x402-bazaar-mcp] Request failed: ${msg}` }],
        isError: true,
      };
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

    // A 402 in free/credits mode is expected sometimes (quota used, paid-only
    // service, or empty balance). Turn it into an actionable hint instead of a
    // bare error so the agent/operator knows exactly how to unlock the call.
    if (response.status === 402) {
      const hint =
        MODE === "credits"
          ? "Prepaid credits exhausted or invalid — top up with the buy_credits tool, or set a funded X402_CREDIT_TOKEN."
          : MODE === "wallet"
            ? "Wallet could not settle the payment — check the AGENT_PRIVATE_KEY wallet's USDC balance on Base."
            : "This call needs payment (free daily quota used, or a paid-only service). Set X402_CREDIT_TOKEN (recommended — buy once, no wallet) or AGENT_PRIVATE_KEY.";
      text = `${text}\n\n[x402-bazaar-mcp] 402 Payment Required — ${hint}`;
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
log(
  `v${VERSION} — mode: ${MODE} — ${added} tool(s) registered (catalog: ${total}).` +
    (MODE === "free"
      ? " Free tier active (1 call/day/service, then preview). Set X402_CREDIT_TOKEN or AGENT_PRIVATE_KEY for paid calls."
      : ""),
);

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
