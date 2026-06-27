/**
 * MCP discovery manifest served at /.well-known/mcp.json — lets MCP-aware
 * clients/agents discover the x402 Bazaar MCP server. Read-only, public.
 */

import { getSiteUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

export function GET() {
  const SITE = getSiteUrl();
  return Response.json({
    name: "x402-bazaar-mcp",
    description:
      "MCP server exposing x402 Bazaar's 40+ onchain data & AI report services on Base. The agent pays per call in USDC over x402 (set AGENT_PRIVATE_KEY); no API keys.",
    version: "0.1.4",
    registry: "io.github.sukrutkrdg/x402-bazaar-mcp",
    npm: "https://www.npmjs.com/package/x402-bazaar-mcp",
    transport: "stdio",
    install: { command: "npx", args: ["-y", "x402-bazaar-mcp"], env: ["AGENT_PRIVATE_KEY"] },
    catalog: `${SITE}/.well-known/x402`,
    homepage: SITE,
  });
}
