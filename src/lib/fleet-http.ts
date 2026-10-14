import { NextRequest, NextResponse } from "next/server";
import { authenticateParent, FleetError } from "@/lib/fleet";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";

/**
 * Shared gate for every fleet management call: rate limit first (per IP, so
 * guessing parent tokens is as slow as guessing them on /api/credits/balance),
 * then the parent token from the HEADER — never the URL, where it would land in
 * access logs — then a second limit per parent so one token can't churn KV.
 */
export async function fleetGate(req: NextRequest): Promise<{ parent: string } | { res: NextResponse }> {
  const ip = await rateLimitKv(`fleet:${clientIp(req)}`, 30, 60);
  if (!ip.ok) return { res: tooMany(ip.retryAfterMs) };
  let parent: string;
  try {
    parent = await authenticateParent(req.headers.get("x-credit-token") || "");
  } catch (err) {
    return { res: fleetErrorResponse(err) };
  }
  const per = await rateLimitKv(`fleet:p:${parent}`, 60, 60);
  if (!per.ok) return { res: tooMany(per.retryAfterMs) };
  return { parent };
}

function tooMany(ms: number) {
  return NextResponse.json(
    { error: `Rate limit — retry in ${Math.ceil(ms / 1000)}s` },
    { status: 429, headers: { "retry-after": String(Math.ceil(ms / 1000)) } },
  );
}

export function fleetErrorResponse(err: unknown) {
  if (err instanceof FleetError) return NextResponse.json({ error: err.message }, { status: err.status, headers: { "cache-control": "no-store" } });
  console.error(`[fleet] ${err instanceof Error ? err.message : String(err)}`);
  return NextResponse.json({ error: "Fleet request failed" }, { status: 500 });
}
