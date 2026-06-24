/** Cheap liveness probe (no async/KV) for monitors & agent bootstrap. */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true, ts: new Date().toISOString() });
}
