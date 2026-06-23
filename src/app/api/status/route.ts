/** Non-secret config status for the UI (are seller + buyer wired up?). */

import { NextResponse } from "next/server";
import { getConfig, sellerReady, buyerReady } from "@/lib/config";
import { getBuyerAddress } from "@/lib/x402-client";

export const dynamic = "force-dynamic";

export async function GET() {
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
  });
}
