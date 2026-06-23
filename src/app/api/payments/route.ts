/** Recent settlements recorded by the demo buyer (for the dashboard). */

import { NextResponse } from "next/server";
import { listPayments } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const payments = await listPayments(50);
  return NextResponse.json({ payments });
}
