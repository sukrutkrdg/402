/** Non-secret config status for the UI (are seller + buyer wired up?). */

import { NextRequest, NextResponse } from "next/server";
import { getConfig, sellerReady, buyerReady } from "@/lib/config";
import { aiConfigured } from "@/lib/ai";
import { freeRemaining } from "@/lib/free-tier";
import { clientIp } from "@/lib/rate-limit";
import { kvConfigured } from "@/lib/kv";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const seller = sellerReady(cfg);
  const buyer = buyerReady(cfg);

  // Public endpoint — expose only non-sensitive booleans (no wallet addresses,
  // no list of which env vars are unset).
  return NextResponse.json({
    network: "Base mainnet (eip155:8453)",
    appBuilderCode: cfg.appBuilderCode,
    clientBuilderCode: cfg.clientBuilderCode,
    seller: { ok: seller.ok },
    buyer: { ok: buyer.ok },
    buyerEnabled: cfg.enableBuyer,
    buyTokenRequired: Boolean(cfg.buyAccessToken),
    aiReady: aiConfigured(),
    alchemyReady: Boolean(process.env.ALCHEMY_API_KEY?.trim()),
    kv: kvConfigured(),
    freeTier: await freeRemaining(`free:${clientIp(req)}`),
  });
}
