/**
 * Machine-readable service catalog for discovery.
 *
 * This is how agents / indexers / x402 directories find what we sell and how to
 * pay: every paid endpoint, its price, its x402 URL, and its input schema — as
 * JSON. Also served at /.well-known/x402 via a rewrite.
 */

import { SERVICES } from "@/lib/services";
import { getConfig, getSiteUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

export function GET() {
  const cfg = getConfig();
  const SITE_URL = getSiteUrl();
  return Response.json({
    name: "x402 Bazaar",
    description:
      "Pay-per-call API marketplace on Base. Call any endpoint over HTTP; pay a USDC micro-payment via x402 (no keys, no accounts). Every payment is attributed onchain with Builder Codes.",
    x402Version: 2,
    protocol: "x402",
    network: "eip155:8453",
    asset: "USDC",
    builderCode: cfg.appBuilderCode,
    baseUrl: SITE_URL,
    docs: `${SITE_URL}/agents`,
    services: SERVICES.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      price: s.price,
      method: "GET",
      x402: true,
      endpoint: `${SITE_URL}/api/x402/${s.id}`,
      input: Object.fromEntries(
        s.params.map((p) => [
          p.name,
          { type: "string", required: Boolean(p.required), description: p.label, in: "query" },
        ]),
      ),
    })),
  });
}
