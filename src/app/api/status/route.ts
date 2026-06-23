/** Non-secret config status for the UI (are seller + buyer wired up?). */

import { NextRequest, NextResponse } from "next/server";
import { getConfig, sellerReady, buyerReady } from "@/lib/config";
import { getBuyerAddress } from "@/lib/x402-client";
import { aiConfigured } from "@/lib/ai";
import { freeRemaining } from "@/lib/free-tier";
import { clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const seller = sellerReady(cfg);
  const buyer = buyerReady(cfg);

  let buyerAddress: string | undefined;
  try {
    buyerAddress = getBuyerAddress();
  } catch {
    buyerAddress = undefined;
  }

  return NextResponse.json({
    network: "Base mainnet (eip155:8453)",
    appBuilderCode: cfg.appBuilderCode,
    clientBuilderCode: cfg.clientBuilderCode,
    payTo: cfg.payTo || null,
    buyerAddress: buyerAddress || null,
    seller,
    buyer,
    buyerEnabled: cfg.enableBuyer,
    buyTokenRequired: Boolean(cfg.buyAccessToken),
    aiReady: aiConfigured(),
    freeTier: freeRemaining(`free:${clientIp(req)}`),
  });
}
