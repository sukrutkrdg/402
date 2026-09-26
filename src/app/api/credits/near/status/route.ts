/**
 * Status of a NEAR Intents credit order; on SUCCESS, the credit token.
 *
 * The order secret travels in the `x-order-secret` HEADER, never the query
 * string — it is what claims a paid balance, and query strings end up in logs.
 * Polling again after SUCCESS returns the same token.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkNearOrder, nearCreditsEnabled, NearOrderError } from "@/lib/near-intents";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!nearCreditsEnabled()) {
    return NextResponse.json({ error: "Paying with NEAR Intents is not enabled on this deployment." }, { status: 404 });
  }

  const rl = await rateLimitKv(`nearstatus:${clientIp(req)}`, 60, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  const orderId = new URL(req.url).searchParams.get("orderId") || "";
  const secret = req.headers.get("x-order-secret") || "";
  if (!orderId || !secret) {
    return NextResponse.json(
      { error: "Pass ?orderId=<orderId> and the header x-order-secret: <orderSecret> from the quote response." },
      { status: 400 },
    );
  }

  try {
    const result = await checkNearOrder(orderId, secret);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const status = err instanceof NearOrderError ? err.status : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
