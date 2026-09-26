/**
 * The /swap page's Base quote: the same 0x swap as the paid base-swap endpoint
 * (sellability check, integrator fee), free for people signing with their own
 * wallet on the page. The fee inside the swap is the revenue; rate-limited per IP.
 */

import { NextRequest, NextResponse } from "next/server";
import { baseSwap } from "@/lib/base-swap";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";
import { onBasePage, PAGE_QUOTES_PER_DAY } from "@/lib/swap-page-tokens";

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
  if (!(onBasePage(params.sell) && onBasePage(params.buy))) {
    return NextResponse.json(
      { error: "This page quotes the tokens in its lists. Any other token: the paid API at /api/x402/base-swap." },
      { status: 400 },
    );
  }
  const day = await rateLimitKv("swapbase:all", PAGE_QUOTES_PER_DAY, 86400);
  if (!day.ok) return NextResponse.json({ error: "The page has handed out today's quotes — try again tomorrow, or use the paid API." }, { status: 429 });
  try {
    return NextResponse.json(await baseSwap(params));
  } catch (e) {
    const msg = (e as Error).message.replace(/ ?—? ?not charged,?/i, "").trim();
    return NextResponse.json({ error: msg }, { status: /unavailable|unreachable|retry shortly|not configured/i.test(msg) ? 503 : 400 });
  }
}
