/**
 * Agent Card — A2A / agent-discovery manifest served at /.well-known/agent.json.
 * Lets agent frameworks discover x402 Bazaar as a callable, x402-paid service
 * provider. Read-only, public, derived from the live service catalog.
 */

import { SERVICES } from "@/lib/services";
import { getSiteUrl, getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export function GET() {
  const SITE = getSiteUrl();
  const cfg = getConfig();
  return Response.json({
    name: "x402 Bazaar",
    description:
      "Pay-per-call onchain data & AI reports for the Base agent economy — token risk, wallet intelligence, OFAC sanctions, prices, NFTs, and Claude-written AI verdicts. Paid per request in USDC over x402, no API keys.",
    url: SITE,
    documentationUrl: `${SITE}/agents`,
    version: "1.0.0",
    provider: { organization: "x402 Bazaar", url: SITE },
    capabilities: {
      streaming: false,
      payments: {
        protocol: "x402",
        network: "eip155:8453",
        currency: "USDC",
        payTo: cfg.payTo,
        attribution: "ERC-8021 Builder Codes",
      },
    },
    discovery: {
      catalog: `${SITE}/.well-known/x402`,
      openapi: `${SITE}/openapi.json`,
      llms: `${SITE}/llms.txt`,
      mcp: "npx x402-bazaar-mcp",
    },
    skills: SERVICES.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.tagline,
      tags: [s.category.toLowerCase()],
      price: s.price,
      endpoint: `${SITE}/api/x402/${s.id}`,
    })),
  });
}
