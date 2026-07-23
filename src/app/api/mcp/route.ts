/**
 * Hosted MCP endpoint (Streamable HTTP) — the remote/no-install version of the
 * x402-bazaar-mcp stdio server, so agents can connect over the network (Glama
 * connectors, Cursor, etc.) instead of `npx`-installing it.
 *
 * Implements the MCP Streamable HTTP transport as plain JSON-RPC over POST
 * (stateless — no session id needed for a request/response tool server). Every
 * tool maps to a service in the x402 catalog and, on call, proxies to the real
 * /api/x402/<service> gateway so ALL payment / free-tier / preview logic is
 * reused. The caller brings their own prepaid credit token via the
 * `x-credit-token` header (configured in the connector); without one they get the
 * free daily call or a 402 with instructions. No wallet is held server-side.
 */

import { NextRequest } from "next/server";
import { SERVICES } from "@/lib/services";
import { getSiteUrl } from "@/lib/config";
import { MCP_CHANNEL_HOST } from "@/lib/usage";
import { rateLimitKv, clientIp } from "@/lib/rate-limit";

const MAX_BATCH = 20; // cap JSON-RPC batch fan-out so one POST can't amplify to N outbound calls

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SERVER = { name: "x402-bazaar", version: "0.3.0" };
const PROTOCOL = "2025-06-18";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-credit-token, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

interface RpcReq { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> }

const visibleServices = () => SERVICES.filter((s) => !s.hidden);

/** Catalog → MCP tool list. Each service becomes one tool. The description uses
 * the full catalog description (what it does + inputs + verdict), not just the
 * tagline — richer, self-disambiguating tool defs that a model/agent (and Glama's
 * quality scorer) can actually reason about. */
function toolList() {
  return visibleServices().map((s) => {
    const properties: Record<string, { type: "string"; description?: string }> = {};
    const required: string[] = [];
    for (const p of s.params) {
      properties[p.name] = { type: "string", description: p.label };
      if (p.required) required.push(p.name);
    }
    // Rich, self-contained description: purpose (tagline) + the full catalog blurb
    // (stripped of the 🆕 marker) + explicit required inputs + how it's paid.
    const blurb = s.description.replace(/^\s*🆕\s*/u, "").trim();
    const reqNote = required.length ? ` Required input${required.length > 1 ? "s" : ""}: ${required.join(", ")}.` : "";
    return {
      name: s.id,
      description: `${s.tagline} — ${blurb}${reqNote} Priced ${s.price} per call over x402 on Base; send a prepaid x-credit-token header for unlimited calls, or get 1 free call/day per tool. No wallet or API key required.`,
      inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
    };
  });
}

/** Run a tool = proxy to the real x402 gateway, forwarding the caller's credit token. */
async function callTool(name: string, args: Record<string, unknown>, creditToken: string) {
  const svc = visibleServices().find((s) => s.id === name);
  if (!svc) return { isError: true, text: `Unknown tool: ${name}` };

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const url = `${getSiteUrl()}/api/x402/${svc.id}${qs.toString() ? `?${qs}` : ""}`;
  // Stamp a sentinel referer so usage can count the hosted-MCP (Glama-connector)
  // channel apart from direct agent/x402 calls (which carry no referer).
  const headers: Record<string, string> = { accept: "application/json", referer: `https://${MCP_CHANNEL_HOST}/api/mcp` };
  if (creditToken) headers["x-credit-token"] = creditToken;

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
    const body = await res.text();
    if (res.status === 402) {
      return {
        isError: true,
        text: `${body}\n\n[x402-bazaar] 402 Payment Required — this needs payment (free daily quota used, or a paid-only tool). Set an x-credit-token header on the connector (buy one once via the buy-credits tool — no wallet needed).`,
      };
    }
    if (!res.ok) return { isError: true, text: `[x402-bazaar] HTTP ${res.status}: ${body.slice(0, 400)}` };
    return { isError: false, text: body };
  } catch (e) {
    return { isError: true, text: `[x402-bazaar] Request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function handle(rpc: RpcReq, creditToken: string): Promise<object | null> {
  const reply = (result: object) => ({ jsonrpc: "2.0" as const, id: rpc.id ?? null, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0" as const, id: rpc.id ?? null, error: { code, message } });

  switch (rpc.method) {
    case "initialize":
      return reply({
        protocolVersion: (rpc.params?.protocolVersion as string) || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions:
          "x402 Bazaar tools: onchain safety, wallet/account intelligence, lending and AI reads on Base, paid per call over x402. Configure an x-credit-token header (buy once via buy-credits, no wallet) for unlimited calls; otherwise 1 free call/day per tool.",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notification — no response
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolList() });
    case "tools/call": {
      const name = String(rpc.params?.name ?? "");
      const args = (rpc.params?.arguments as Record<string, unknown>) ?? {};
      const out = await callTool(name, args, creditToken);
      return reply({ content: [{ type: "text", text: out.text }], isError: out.isError });
    }
    default:
      return err(-32601, `Method not found: ${rpc.method}`);
  }
}

export async function POST(req: NextRequest) {
  // The endpoint is unauthenticated (a credit token is optional and per-caller), so
  // cap it per IP — without this a loop of tool-calls fans out to the gateway.
  const rl = await rateLimitKv(`mcp:${clientIp(req)}`, 60, 60);
  if (!rl.ok) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Too many requests — retry shortly" } }, { status: 429, headers: CORS });
  }
  const creditToken = (req.headers.get("x-credit-token") || "").trim();
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: CORS });
  }

  // Streamable HTTP allows a single request or a batch; cap batch size so one POST
  // can't spawn an unbounded number of concurrent outbound calls to the gateway.
  const batch = (Array.isArray(payload) ? (payload as RpcReq[]) : [payload as RpcReq]).slice(0, MAX_BATCH);
  const responses = (await Promise.all(batch.map((r) => handle(r, creditToken)))).filter((x): x is object => x !== null);

  // Only notifications (no responses) → 202 Accepted, empty body.
  if (responses.length === 0) return new Response(null, { status: 202, headers: CORS });
  const out = Array.isArray(payload) ? responses : responses[0];
  return Response.json(out, { headers: { ...CORS, "Content-Type": "application/json" } });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export function GET() {
  // No server-initiated SSE stream for this stateless server.
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Use POST for the MCP Streamable HTTP transport." } },
    { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } },
  );
}
