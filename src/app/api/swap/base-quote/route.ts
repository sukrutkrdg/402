/**
 * The /swap page's Base quote: the same 0x swap as the paid base-swap endpoint
 * (sellability check, integrator fee), free for people signing with their own
 * wallet on the page. The fee inside the swap is the revenue; rate-limited per IP.
 */

import { NextRequest, NextResponse } from "next/server";
import { baseSwap } from "@/lib/base-swap";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rl = await rateLimitKv(`swapbase:${clientIp(req)}`, 20, 60);
  if (!rl.ok) return NextResponse.json({ error: `Too many quotes — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` }, { status: 429 });
  const p = req.nextUrl.searchParams;
  const params: Record<string, string> = {};
  for (const k of ["sell", "buy", "amount", "taker", "slippage"]) {
    const v = p.get(k);
    if (v) params[k] = v;
  }
  try {
    return NextResponse.json(await baseSwap(params));
  } catch (e) {
    const msg = (e as Error).message.replace(/ ?—? ?not charged,?/i, "").trim();
    return NextResponse.json({ error: msg }, { status: /unavailable|unreachable|retry shortly|not configured/i.test(msg) ? 503 : 400 });
  }
}
