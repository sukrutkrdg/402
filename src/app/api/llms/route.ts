/** llms.txt — tells AI crawlers/agents what this site offers and how to pay. Served at /llms.txt. */

import { SERVICES } from "@/lib/services";
import { getConfig, getSiteUrl } from "@/lib/config";
import { freeLimit } from "@/lib/free-tier";

export const dynamic = "force-dynamic";

export function GET() {
  const site = getSiteUrl();
  const cfg = getConfig();
  const lines = [
    "# x402 Bazaar",
    "",
    "> Pay-per-call API marketplace on Base. Call any endpoint over HTTP and pay a tiny USDC micro-payment via the x402 protocol — no API keys, no accounts, no subscriptions. Built for AI agents and bots.",
    "",
    "## How payment works",
    `Every endpoint returns HTTP 402 Payment Required with x402 payment details (USDC on Base, network eip155:8453, pay to ${cfg.payTo || "<seller>"}). Use an x402 client such as @x402/fetch to pay automatically and retry. The first ${freeLimit()} calls per day per IP are free (trial).`,
    "",
    "## Discovery",
    `- Machine-readable catalog (JSON): ${site}/.well-known/x402`,
    `- OpenAPI spec: ${site}/openapi.json`,
    `- Agent docs + ready-to-run MCP server: ${site}/agents`,
    "",
    "## Services",
    ...SERVICES.map(
      (s) =>
        `- [${s.name}](${site}/api/x402/${s.id}) — ${s.price} — ${s.tagline}. Query params: ${
          s.params.map((p) => p.name).join(", ") || "none"
        }`,
    ),
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
