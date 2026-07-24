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
    // Decision quality, not just payment success — how an agent decides to route
    // work here by default. Full schema in the catalog under `decisionReceipt`.
    decisionReceipt: {
      summary:
        "Every paid response carries a verifiable receipt: inputHash (sha256 of exact inputs) + policyVersion (endpoint@semver); verdict checks add a confidence band, a structured refusal shape, and an enforced refund rule (a refusal is auto-refunded on the credit path, x-refunded:true).",
      schema: `${SITE}/.well-known/x402`,
      docs: "https://github.com/sukrutkrdg/402/blob/main/docs/decision-receipt.md",
    },
    freeTrial: "1 free call per service per day per IP (AI and metered services excluded) — try before you pay, no signup.",
    tryExample: `${SITE}/api/x402/token-risk?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
    // The 3 tools most agents should bind first, and the B20 suite grouped into 5
    // fronts so a tool-binding client isn't lost among ~20 similar B20 skills.
    startHere: ["pre-trade-gate", "b20-gate", "sign-guard"],
    b20Suite: {
      about: "Base-native B20 tokens: protocol-level freeze/seize/pause powers no ERC-20 tool can see.",
      gate: ["b20-authenticity", "b20-gate", "b20-transfer-preflight"],
      dossier: ["b20-safety", "b20-info", "b20-control", "b20-policy-admin", "b20-access-type", "b20-policy-members", "b20-supply", "b20-metadata", "b20-rebase", "b20-rebase-history", "b20-stablecoin", "b20-peg", "b20-seizure-history", "b20-genesis-audit", "b20-config-audit", "b20-dossier"],
      myWallet: ["b20-freeze-check", "b20-portfolio"],
      monitoring: ["b20-policy-watch", "b20-guard", "b20-launch-radar", "b20-mint-watch", "b20-announcements"],
      rails: ["b20-memo", "b20-permit"],
    },
    skills: SERVICES.filter((s) => !s.hidden).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.tagline,
      tags: [s.category.toLowerCase()],
      price: s.price,
      endpoint: `${SITE}/api/x402/${s.id}`,
      // params so a binding agent knows how to call it without a second fetch
      parameters: s.params.map((p) => ({ name: p.name, required: Boolean(p.required), description: p.label })),
    })),
  });
}
