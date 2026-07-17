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
    `Every endpoint returns HTTP 402 Payment Required with x402 payment details (USDC on Base, network eip155:8453, pay to ${cfg.payTo || "<seller>"}). Use an x402 client such as @x402/fetch to pay automatically and retry. Free trial: ${freeLimit()} free call/day per service per IP (AI and metered services excluded — those are always paid). Prepaid credits: one settlement on /api/x402/buy-credits (tier=0.25|1|5|20) mints an x-credit-token that later calls debit — no per-call signature.`,
    "",
    "## Discovery",
    `- Machine-readable catalog (JSON): ${site}/.well-known/x402`,
    `- OpenAPI spec: ${site}/openapi.json`,
    `- Agent docs + ready-to-run MCP server: ${site}/agents`,
    "",
    "## Start here (bind these first)",
    `- Trading a token? [pre-trade-gate](${site}/api/x402/pre-trade-gate) — one GO/HOLD/STOP (risk + sellability + route + deployer).`,
    `- Trading a Base-native B20 token? [b20-gate](${site}/api/x402/b20-gate) — the seize/freeze/pause verdict ERC-20 tools can't give.`,
    `- About to sign a tx? [sign-guard](${site}/api/x402/sign-guard) — decodes the calldata and flags drain/approval risk.`,
    "",
    "## B20 suite (Base-native tokens) — 5 ways in",
    "B20 is Base's native token standard (Beryl): issuers can freeze/seize/pause holders at the protocol level — powers no ERC-20 tool can see. Bind by need:",
    `- Gate (before you trade/transfer): b20-gate (per-token GO/HOLD/STOP), b20-transfer-preflight (will THIS from→to transfer clear now — the per-payment check).`,
    `- Dossier (one deep read of a token): b20-safety (risk verdict), b20-info, b20-control (who holds mint/seize roles), b20-policy-admin, b20-access-type (allowlist vs blocklist), b20-supply, b20-metadata, b20-rebase, b20-stablecoin.`,
    `- My wallet (am I exposed): b20-freeze-check (is one wallet blocked on a token), b20-portfolio (scan a wallet's B20 holdings).`,
    `- Monitoring (did something change): b20-policy-watch (timeline), b20-guard (real-time seizable feed), b20-launch-radar (new B20s), b20-announcements.`,
    `- Rails (settling in B20): b20-memo (tagged transfers), b20-permit (gasless approval prep).`,
    "",
    "## All services",
    ...SERVICES.filter((s) => !s.hidden).map(
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
