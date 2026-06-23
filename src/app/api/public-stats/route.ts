/** Public, non-sensitive vanity stats for the landing strip (no revenue, no per-service breakdown). */

import { NextResponse } from "next/server";
import { SERVICES } from "@/lib/services";
import { getCallsServed } from "@/lib/usage";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    services: SERVICES.length,
    callsServed: await getCallsServed(),
  });
}
