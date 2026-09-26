/** The /swap page's progress check: 1Click's status for a deposit address. Free, rate-limited. */

import { NextRequest, NextResponse } from "next/server";
import { nearSwapStatus } from "@/lib/near-swap";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rl = await rateLimitKv(`swapstatus:${clientIp(req)}`, 30, 60);
  if (!rl.ok) return NextResponse.json({ error: "Too many checks — slow down" }, { status: 429 });
  const depositAddress = req.nextUrl.searchParams.get("depositAddress") ?? "";
  try {
    return NextResponse.json(await nearSwapStatus({ depositAddress }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.replace(/ ?—? ?not charged,?/i, "").trim() }, { status: 400 });
  }
}
