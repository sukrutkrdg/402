/**
 * Diagnostic: run a service handler directly (NO payment) to isolate whether a
 * failure is in the handler vs the x402 settlement. Gated by CRON_SECRET.
 *   /api/admin/test-service?id=ai-token-report&address=0x…
 */

import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/secure";
import { getService } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  const service = getService(id);
  if (!service) return NextResponse.json({ error: `Unknown service: ${id}` }, { status: 404 });

  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k !== "id") params[k] = v;
  }

  const t0 = Date.now();
  try {
    const data = await service.handler(params);
    return NextResponse.json({ ok: true, id, ms: Date.now() - t0, data });
  } catch (e) {
    return NextResponse.json(
      { ok: false, id, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    );
  }
}
