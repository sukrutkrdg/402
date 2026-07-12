/** Public, non-sensitive vanity stats for the landing strip (no revenue, no per-service breakdown). */

import { NextResponse } from "next/server";
import { SERVICES } from "@/lib/services";
import { getCallsServed, getPaidServed } from "@/lib/usage";

export const dynamic = "force-dynamic";

export async function GET() {
  const [callsServed, paidServed] = await Promise.all([getCallsServed(), getPaidServed()]);
  return NextResponse.json({
    services: SERVICES.filter((s) => !s.hidden).length,
    callsServed,
    paidServed,
  });
}
