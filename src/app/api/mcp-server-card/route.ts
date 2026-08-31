/**
 * MCP server card — served at /.well-known/mcp/server-card.json.
 *
 * A static, authoritative description of the x402-bazaar MCP server and its full
 * tool list, in the MCP server-card shape. Registries (e.g. Smithery) that can't
 * auto-scan an npx/stdio server with a dynamically loaded catalog use this card to
 * list our tools WITHOUT running the server — no scan, no auth wall. Generated
 * live from the same catalog the running server registers, so it never drifts.
 */

import { mcpToolList } from "@/lib/mcp-tools";
import { getSiteUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

// Keep in step with the published npm package + registry entry.
const MCP_VERSION = "0.2.7";

export function GET() {
  const SITE = getSiteUrl();

  // The tool list comes from the shared builder, not from a second copy of the
  // mapping. This file used to build its own and claimed in its header that it
  // therefore "never drifts" — it drifted twice. Most recently it was the only
  // surface still missing outputSchema and annotations, which is precisely the
  // surface Smithery scores: its publish log reads
  // `Using .well-known/mcp/server-card.json: (137 tools)`. It never calls
  // tools/list, so a correct hosted endpoint bought us nothing here.
  const tools = mcpToolList();

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
      // Optional, not required — the free tier works with nothing set. But it has
      // to be DECLARED, because a hosted connector only prompts for values it
      // knows about. Smithery warned on this exactly: "users will not be prompted
      // for these values". Without it, an agent installed from a directory can
      // only ever use the free call and can never become a paying customer,
      // which quietly caps that whole channel at zero revenue.
      configSchema: {
        type: "object",
        required: [],
        properties: {
          creditToken: {
            type: "string",
            title: "Prepaid credit token (recommended)",
            description:
              "A ck_… token minted by one x402 settlement on buy-credits. Sent as the x-credit-token header; each call debits the prepaid balance with no wallet and no signature per call. Leave blank to stay on the free tier: 1 call/day/service, then a preview.",
          },
        },
      },
      instructions:
        "Pay-per-call Base onchain-safety, wallet-intel & AI tools. Free tier: 1 call/day/service then a preview. For unlimited paid calls set X402_CREDIT_TOKEN (prepaid, no wallet) or AGENT_PRIVATE_KEY. Install: npx -y x402-bazaar-mcp.",
      tools,
      _meta: {
        npm: "https://www.npmjs.com/package/x402-bazaar-mcp",
        registry: "io.github.sukrutkrdg/x402-bazaar-mcp",
        homepage: SITE,
        catalog: `${SITE}/.well-known/x402`,
        install: { command: "npx", args: ["-y", "x402-bazaar-mcp"] },
        // Preferred by every zero-install surface (Smithery, Claude and ChatGPT
        // connectors); none of them can take a stdio server.
        remote: { type: "streamable-http", url: `${SITE}/mcp` },
        toolCount: tools.length,
      },
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
