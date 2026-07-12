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
  return Response.json(
    {
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
    // How to pay, and what each status means — so an agent handles non-200s.
    payment: {
      how: "GET the endpoint; on 402 read the accepts[] (price, payTo, asset, network), pay a USDC micro-payment via x402, and retry with the x-payment header. Libraries (@x402/fetch) do this automatically.",
      freeTier: "1 free call per service per day per IP (full result); after that, unpaid calls return a preview (headline only) with an 'unlock' message. Services with freeTier:false (AI/metered) are always paid.",
      credits: "Prepaid alternative: one x402 settlement on /api/x402/buy-credits (tier=0.25|1|5|20 USD; $5/$20 carry a bonus) returns a bearer creditToken (shown once). Send it as the x-credit-token header on any paid call — the price is debited from your balance, no per-call signature or settlement. Responses carry paidVia:'credits', creditBalanceUsd, and the x-credit-balance header (cents). Balance lasts 180 days.",
    },
    errors: {
      "200": "Success — full result (paid or free call), or a preview when the free tier is used up (preview:true).",
      "400": "Bad input (e.g. missing/invalid address). You were NOT charged.",
      "402": "Payment required — pay per accepts[] and retry with x-payment. The body may include a 'sample' (preview of a recent real response), 'freeCall' and 'noWalletNeeded' hints. With an x-credit-token, a 402 means the balance is too low (body has balanceUsd + topUp).",
      "429": "Rate limited — back off and retry after the retry-after header.",
      "502": "Upstream data provider failed. You were NOT charged; retry later.",
    },
    // Extra fields an agent may see in paid responses (all optional):
    responseFields: {
      sinceLastCheck: "token-risk / rug-score: how the score moved since this token was last checked from your network.",
      receipt: "auditable pre-spend record (checked, at, decision, observedRisks) on risk services.",
      upgrade: "a discounted follow-up offer (e.g. paying token-risk earns ai-token-report at $0.05 for 1h on the same token).",
      paidVia: "'credits' when the call was debited from a prepaid balance instead of an x402 settlement.",
    },
    services: SERVICES.filter((s) => !s.hidden).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      demo: s.category === "Demo",
      requiresAI: s.category === "AI",
      price: s.price,
      // Whether the daily free trial applies — AI/metered services never serve free.
      freeTier: s.category !== "AI" && !s.noFreeTier,
      // buy-credits actually charges the chosen tier, not the listed base price.
      ...(s.id === "buy-credits" ? { tiers: { "0.25": "$0.25", "1": "$1.00", "5": "$5.00 (+10% bonus)", "20": "$20.00 (+20% bonus)" } } : {}),
      method: "GET",
      x402: true,
      endpoint: `${SITE_URL}/api/x402/${s.id}`,
      input: Object.fromEntries(
        s.params.map((p) => [
          p.name,
          { type: "string", required: Boolean(p.required), description: p.label, in: "query", example: p.placeholder || undefined },
        ]),
      ),
    })),
    // First-party partner services (same owner, separate host) — listed so
    // agents discovering the Bazaar also find them; they settle via x402 too.
    partners: [
      {
        name: "Warden",
        description:
          "Pre-execution security for agents on Base: token/address/tx risk verdicts (block/review/clear), calldata decode + simulation. x402-paid guard API + free-tier firewall keys.",
        baseUrl: "https://warden402.xyz",
        catalog: "https://warden402.xyz/.well-known/x402",
        x402: true,
        network: "eip155:8453",
      },
    ],
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
