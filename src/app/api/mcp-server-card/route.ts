/**
 * MCP server card — served at /.well-known/mcp/server-card.json.
 *
 * A static, authoritative description of the x402-bazaar MCP server and its full
 * tool list, in the MCP server-card shape. Registries (e.g. Smithery) that can't
 * auto-scan an npx/stdio server with a dynamically loaded catalog use this card to
 * list our tools WITHOUT running the server — no scan, no auth wall. Generated
 * live from the same catalog the running server registers, so it never drifts.
 */

import { SERVICES } from "@/lib/services";
import { getSiteUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

// Keep in step with the published npm package + registry entry.
const MCP_VERSION = "0.2.1";

export function GET() {
  const SITE = getSiteUrl();

  // One MCP tool per non-hidden service — same underscore naming and input schema
  // the stdio server builds at registration time.
  const tools = SERVICES.filter((s) => !s.hidden).map((s) => {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];
    for (const p of s.params) {
      properties[p.name] = { type: "string", description: p.label };
      if (p.required) required.push(p.name);
    }
    return {
      name: s.id.replace(/-/g, "_"),
      description: s.description,
      inputSchema: { type: "object", properties, required },
    };
  });

  return Response.json(
    {
      // MCP server-card fields (aligned with the MCP SDK initialize result).
      serverInfo: { name: "x402-bazaar", version: MCP_VERSION },
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: true } },
      // Free tier works with no credentials — nothing to authorize. Paid calls use
      // a prepaid credit token (x-credit-token) or a wallet key, handled by the
      // client, not an MCP auth handshake.
      authentication: { required: false },
      instructions:
        "Pay-per-call Base onchain-safety, wallet-intel & AI tools. Free tier: 1 call/day/service then a preview. For unlimited paid calls set X402_CREDIT_TOKEN (prepaid, no wallet) or AGENT_PRIVATE_KEY. Install: npx -y x402-bazaar-mcp.",
      tools,
      _meta: {
        npm: "https://www.npmjs.com/package/x402-bazaar-mcp",
        registry: "io.github.sukrutkrdg/x402-bazaar-mcp",
        homepage: SITE,
        catalog: `${SITE}/.well-known/x402`,
        install: { command: "npx", args: ["-y", "x402-bazaar-mcp"] },
        toolCount: tools.length,
      },
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
