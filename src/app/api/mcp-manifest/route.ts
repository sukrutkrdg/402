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
      "MCP server exposing x402 Bazaar's 60+ onchain safety, wallet-intel & AI tools on Base. Zero-config free tier (1 call/day/service, then a preview); pay for unlimited with a prepaid credit token (X402_CREDIT_TOKEN — no wallet) or a wallet key (AGENT_PRIVATE_KEY). No API keys.",
    version: "0.2.1",
    registry: "io.github.sukrutkrdg/x402-bazaar-mcp",
    npm: "https://www.npmjs.com/package/x402-bazaar-mcp",
    transport: "stdio",
    install: { command: "npx", args: ["-y", "x402-bazaar-mcp"], env: ["X402_CREDIT_TOKEN", "AGENT_PRIVATE_KEY"] },
    serverCard: `${SITE}/.well-known/mcp/server-card.json`,
    catalog: `${SITE}/.well-known/x402`,
    homepage: SITE,
  });
}
