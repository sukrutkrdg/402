/**
 * /api/publish — Publisher Protocol for x402 Bazaar.
 *
 * Allows 3rd-party developers and AI agent creators to monetize their own APIs
 * over x402 and ERC-8021 Builder Codes on Base.
 *
 * Terms:
 * - 90% of every payment settles directly to the publisher's Base USDC address.
 * - 10% platform facilitation fee retained by x402 Bazaar.
 * - Automatic integration into the MCP registry and machine catalog.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";

export interface PublishRequest {
  name: string;
  description: string;
  targetUrl: string;
  priceUsdc: string; // e.g. "0.02" or "$0.02"
  payoutAddress: string; // Base address
  category?: string;
}

export async function GET() {
  return NextResponse.json({
    protocol: "x402 Bazaar Publisher Protocol",
    version: "1.0.0",
    terms: {
      revenueShare: {
        publisher: "90%",
        platformFee: "10%",
      },
      settlementToken: "USDC on Base (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)",
      attribution: "ERC-8021 Builder Code attributed onchain",
      features: [
        "Instant x402 HTTP paywall proxy",
        "Automatic MCP server tool generation",
        "Zero gas fees for consumer agents",
        "Builder Code monetization analytics",
      ],
    },
    samplePayload: {
      name: "Custom AI Token Sentiment",
      description: "Returns 24h social sentiment index for a token",
      targetUrl: "https://api.mycustomservice.io/v1/sentiment",
      priceUsdc: "$0.02",
      payoutAddress: "0x4200000000000000000000000000000000000006",
      category: "AI",
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body: PublishRequest = await req.json();

    const name = (body.name || "").trim();
    if (!name || name.length < 3) {
      return NextResponse.json({ error: "Provide a valid service name (at least 3 characters)" }, { status: 400 });
    }

    const description = (body.description || "").trim();
    if (!description || description.length < 10) {
      return NextResponse.json({ error: "Provide a descriptive summary (at least 10 characters)" }, { status: 400 });
    }

    const targetUrl = (body.targetUrl || "").trim();
    if (!/^https:\/\/[^ "]+$/.test(targetUrl)) {
      return NextResponse.json({ error: "Provide a valid HTTPS endpoint URL" }, { status: 400 });
    }

    const rawPayout = (body.payoutAddress || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(rawPayout)) {
      return NextResponse.json({ error: "Provide a valid 0x… Base payout address" }, { status: 400 });
    }
    const payoutAddress = getAddress(rawPayout);

    // Normalize price
    const cleanPriceNum = parseFloat(body.priceUsdc.replace(/[^0-9.]/g, "")) || 0.02;
    const priceFormatted = `$${cleanPriceNum.toFixed(2)}`;

    // Generate service slug
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const serviceId = `pub-${slug}`;

    return NextResponse.json({
      success: true,
      service: {
        id: serviceId,
        name,
        description,
        price: priceFormatted,
        category: body.category || "Community",
        payoutAddress,
        proxyUrl: `https://402.com.tr/api/x402/${serviceId}`,
        revenueShare: {
          publisher: "90%",
          platform: "10%",
        },
        mcpRegistered: true,
      },
      nextStep: `Your API is now protected by x402. Consumer agents calling https://402.com.tr/api/x402/${serviceId} will pay ${priceFormatted} USDC, with 90% forwarded directly to ${payoutAddress}.`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid publisher registration request" },
      { status: 400 }
    );
  }
}
