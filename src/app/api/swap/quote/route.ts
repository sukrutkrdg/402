/**
 * The /swap page's quote: the same NEAR Intents swap as the paid near-swap
 * endpoint (safety check, distribution fee, bookkeeping), free for people using
 * the page. The fee on the swap itself is the revenue here, so the call is not
 * charged; it is rate-limited per IP instead.
 */

import { NextRequest, NextResponse } from "next/server";
import { nearSwap } from "@/lib/near-swap";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";
import { onNearPage, PAGE_QUOTES_PER_DAY } from "@/lib/swap-page-tokens";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rl = await rateLimitKv(`swapquote:${clientIp(req)}`, 10, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Too many quotes — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Send JSON: { from, to, amount, recipient, refundTo }" }, { status: 400 });
  }
  const params: Record<string, string> = {};
  for (const k of ["from", "to", "amount", "recipient", "refundTo", "slippage"]) {
    if (typeof body[k] === "string" || typeof body[k] === "number") params[k] = String(body[k]);
  }
  if (!(onNearPage(params.from) && onNearPage(params.to))) {
    return NextResponse.json(
      { error: "This page quotes the tokens in its lists. Any other token: the paid API at /api/x402/near-swap." },
      { status: 400 },
    );
  }
  const day = await rateLimitKv("swapquote:all", PAGE_QUOTES_PER_DAY, 86400);
  if (!day.ok) return NextResponse.json({ error: "The page has handed out today's quotes — try again tomorrow, or use the paid API." }, { status: 429 });
  try {
    return NextResponse.json(await nearSwap(params));
  } catch (e) {
    const msg = (e as Error).message.replace(/ ?—? ?not charged,?/i, "").trim();
    const upstream = /unavailable|unreachable|retry shortly/i.test(msg);
    return NextResponse.json({ error: msg }, { status: upstream ? 503 : 400 });
  }
}
