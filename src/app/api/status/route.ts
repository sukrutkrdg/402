/** Non-secret config status for the UI (are seller + buyer wired up?). */

import { NextRequest, NextResponse } from "next/server";
import { getConfig, sellerReady, buyerReady } from "@/lib/config";
import { aiConfigured } from "@/lib/ai";
import { searchConfigured } from "@/lib/web-search";
import { exaConfigured } from "@/lib/exa";
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
    // web-search sells an upstream we pay for, so "is the key actually in the
    // deployed env" is a question we need answerable from outside — otherwise
    // the only way to find out is a buyer hitting a service that cannot serve.
    searchReady: searchConfigured(),
    // Same reason as searchReady: exa-search is paid-only and spends an upstream
    // credit, so "is the key in the deployed env" must be answerable without a
    // buyer discovering the answer at their own expense.
    exaReady: exaConfigured(),
    kv: kvConfigured(),
    freeTier: await freeRemaining(`free:${clientIp(req)}`),
  });
}
