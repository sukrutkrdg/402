/**
 * Fleet: child credit tokens that spend from your balance under limits you set.
 *
 *   GET  /api/credits/fleet   list children with today's spend
 *   POST /api/credits/fleet   create one: { label, dailyCapUsd, perCallMaxUsd?, allow? }
 *
 * Authenticated by the PARENT credit token in the `x-credit-token` header.
 * See src/lib/fleet.ts for the model.
 */

import { NextRequest, NextResponse } from "next/server";
import { createChild, listChildren, MAX_CHILDREN } from "@/lib/fleet";
import { fleetGate, fleetErrorResponse } from "@/lib/fleet-http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const g = await fleetGate(req);
  if ("res" in g) return g.res;
  try {
    const children = await listChildren(g.parent);
    return NextResponse.json(
      {
        children,
        maxChildren: MAX_CHILDREN,
        day: new Date().toISOString().slice(0, 10),
        note: "spentTodayUsd counts this UTC day; caps reset at 00:00 UTC.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return fleetErrorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  const g = await fleetGate(req);
  if ("res" in g) return g.res;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return NextResponse.json({ error: "Send a JSON body: { label, dailyCapUsd, perCallMaxUsd?, allow? }" }, { status: 400 });
  }
  try {
    const created = await createChild(g.parent, body);
    return NextResponse.json(created, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return fleetErrorResponse(err);
  }
}
