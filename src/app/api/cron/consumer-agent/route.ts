/**
 * Consumer Agent — PERMANENTLY DISABLED.
 *
 * This used to be an autonomous agent that paid for x402 Bazaar services to seed
 * usage/liveness. It's now a no-op: self-generated volume from our own wallet is
 * not organic and can disqualify the app from Base Builder Rewards. Kept as a
 * clean stub so any cron still pointed here returns without spending.
 */

import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/secure";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({ skipped: "consumer-agent permanently disabled (self-buy off)", settled: 0 });
}
