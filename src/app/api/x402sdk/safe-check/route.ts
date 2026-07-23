/**
 * ISOLATED EXPERIMENT (branch x402-sdk-test) — do NOT keep in production.
 *
 * Purpose: test whether Coinbase's *opinionated* CDP x402 SDK
 * (`createX402Server` from `@coinbase/cdp-sdk/x402`) settles + Bazaar-indexes a
 * resource that our hand-wired `withX402` path could not (the 5 stuck services
 * that 402 at facilitator verify with "first-seen malformed payload").
 *
 * This route deliberately bypasses the dynamic `[service]` handler so the ONLY
 * variables that change are the seller-side wiring: the CDP SDK auto-registers
 * all three CDP extensions (incl. the Bazaar declaration) and syncs supported
 * schemes with the facilitator on init. We keep our own payTo via
 * `payToConfig:{type:"address"}` (no CDP wallet provisioned, no WALLET_SECRET).
 *
 * If a real payment here settles cleanly, the SDK path is our fix and we migrate
 * the stuck services onto it. If it still 402s, the block is purely CDP-side.
 */

import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { withX402FromHTTPServer } from "@x402/next";
import { getConfig } from "@/lib/config";
import { PAY_TO } from "@/lib/x402-wallet";
import { safeCheck } from "@/lib/safe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const RESOURCE_PATH = "/api/x402sdk/safe-check";

let cached: Awaited<ReturnType<typeof createX402Server>> | undefined;

/** Build the CDP-SDK resource server once (facilitator handshake is cached). */
async function server() {
  if (cached) return cached;
  const cfg = getConfig();
  cached = await createX402Server({
    apiKeyId: cfg.cdpApiKeyId,
    apiKeySecret: cfg.cdpApiKeySecret,
    // Keep our existing payout address; do not provision a CDP wallet.
    payToConfig: { type: "address", evm: PAY_TO },
    routes: {
      [`GET ${RESOURCE_PATH}`]: {
        price: "$0.02",
        description:
          "Gnosis Safe multisig health check on Base — owners, threshold, enabled modules and delegatecall/guard risk flags for any Safe or treasury address.",
        // EVM-only so no Solana receiver is required.
        networks: ["eip155:8453"],
      },
    },
  });
  return cached;
}

async function handler(req: NextRequest): Promise<NextResponse> {
  const address = new URL(req.url).searchParams.get("address") ?? "";
  try {
    const out = await safeCheck({ address });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  const s = await server();
  const guarded = withX402FromHTTPServer(handler, s);
  return guarded(req);
}
