import { NextRequest, NextResponse } from "next/server";
import { SERVICES, type ServiceDef } from "@/lib/services";
import { getSiteUrl } from "@/lib/config";
import { tagsFor } from "@/lib/tags";

export const dynamic = "force-dynamic";

const BUILDER_CODE = "bc_pa0gqlv1";

interface ResolveMatch {
  serviceId: string;
  name: string;
  description: string;
  priceUsdc: number;
  priceCents: number;
  confidenceScore: number; // 0 to 100
  matchReason: string;
  endpointUrl: string;
  categoryTags: string[];
  sampleRequest: {
    method: "GET" | "POST";
    url: string;
    headers: Record<string, string>;
  };
}


const QUERY_STOPWORDS = new Set([
  "i", "me", "my", "need", "to", "check", "from", "on", "a", "an", "the", "in", "for", "with", "is", "of", "and", "or", "how", "what", "can", "please", "get", "want", "find", "arbitrary"
]);

/**
 * Score a service against a query using token matching, title weights, description, and tags.
 */
function scoreService(service: ServiceDef, queryTokens: string[]): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];
  const sTags = tagsFor(service).map((t) => t.toLowerCase());
  const sName = service.name.toLowerCase();
  const sId = service.id.toLowerCase();
  const sDesc = (service.description || "").toLowerCase();

  for (const token of queryTokens) {
    if (token.length < 2 || QUERY_STOPWORDS.has(token)) continue;

    const isCommonToken = token === "base" || token === "token" || token === "api";
    const idWeight = isCommonToken ? 10 : 45;
    const nameWeight = isCommonToken ? 8 : 30;
    const tagWeight = isCommonToken ? 5 : 25;

    // Exact ID match or segment match
    if (sId === token || sId.split("-").includes(token)) {
      score += idWeight;
      reasons.push(`matches service ID (${token})`);
    } else if (sId.includes(token)) {
      score += Math.floor(idWeight * 0.7);
      reasons.push(`partial ID match (${token})`);
    }

    // Name match
    if (sName.includes(token)) {
      score += nameWeight;
      reasons.push(`title match (${token})`);
    }

    // Tag match
    if (sTags.some((tag) => tag === token || tag.includes(token))) {
      score += tagWeight;
      reasons.push(`category tag (${token})`);
    }

    // Description match
    if (sDesc.includes(token)) {
      score += isCommonToken ? 2 : 12;
      reasons.push(`description match (${token})`);
    }
  }

  // Cap at 99 unless perfect match
  return {
    score: Math.min(score, 99),
    reason: reasons.slice(0, 2).join(", ") || "keyword similarity",
  };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();

  return handleResolve(q);
}

export async function POST(req: Request) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      try {
        const text = await req.text();
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
    }
    const q = (body.q || body.query || body.intent || body.need || "").trim();
    return handleResolve(q);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body. Pass { query: string }" },
      { status: 400 }
    );
  }
}

function handleResolve(input: string) {
  // Every token is scored against the whole catalog; cap the input so a huge body
  // is not a CPU amplifier.
  const rawQuery = input.slice(0, 500);
  const siteUrl = getSiteUrl();

  if (!rawQuery) {
    return NextResponse.json(
      {
        status: "ok",
        message: "Pass ?q=<query> or POST { query } to resolve any agent intent to an x402 endpoint.",
        totalIndexedServices: SERVICES.length,
        builderCode: BUILDER_CODE,
      },
      {
        status: 200,
        headers: { "x-builder-code": BUILDER_CODE },
      }
    );
  }

  const queryLower = rawQuery.toLowerCase();
  const tokens = queryLower.split(/[\s,./\-_+]+/).filter(Boolean);

  // Score all 225 services
  const scored = SERVICES.map((s) => {
    const { score, reason } = scoreService(s, tokens);
    return {
      service: s,
      score,
      reason,
    };
  })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const topMatches: ResolveMatch[] = scored.slice(0, 5).map(({ service, score, reason }) => {
    const rawNum = parseFloat(String(service.price).replace(/[^0-9.]/g, "")) || 0.02;
    const priceUsdc = Number(rawNum.toFixed(4));
    const priceCents = Math.round(rawNum * 100);
    const endpointUrl = `${siteUrl}/api/x402/${service.id}`;
    return {
      serviceId: service.id,
      name: service.name,
      description: service.description,
      priceUsdc,
      priceCents,
      confidenceScore: score,
      matchReason: reason,
      endpointUrl,
      categoryTags: tagsFor(service),
      sampleRequest: {
        method: "GET",
        url: `${endpointUrl}?free=1`,
        headers: {
          Accept: "application/json",
          "x-402-mode": "exact",
        },
      },
    };
  });

  return NextResponse.json(
    {
      status: "ok",
      query: rawQuery,
      builderCode: BUILDER_CODE,
      resolved: topMatches.length > 0,
      bestMatch: topMatches[0] || null,
      alternatives: topMatches.slice(1),
      directExecutionSnippet: topMatches[0]
        ? {
            curl: `curl -H "x-payment: <eip3009_auth>" "${topMatches[0].endpointUrl}"`,
            python: `from x402_bazaar import BazaarClient\nclient = BazaarClient()\nres = client.call("${topMatches[0].serviceId}")`,
            typescript: `import { x402Fetch } from "@x402/fetch";\nconst res = await x402Fetch("${topMatches[0].endpointUrl}");`,
          }
        : null,
      autonomousDiscoveryNote:
        topMatches.length > 0
          ? `Matched in the ${SERVICES.length}-service catalog. Call it with an x402 payment, or ?free=1 where the free tier applies.`
          : "No matching service in the catalog.",
    },
    {
      status: 200,
      headers: {
        "x-builder-code": BUILDER_CODE,
        "content-type": "application/json",
      },
    }
  );
}
