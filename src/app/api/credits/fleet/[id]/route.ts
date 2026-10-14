/**
 *   PATCH  /api/credits/fleet/<id>   { status: "paused" | "active" } — the kill switch
 *   DELETE /api/credits/fleet/<id>   revoke the child for good
 *
 * `<id>` is the child's public id (a hash of its token, returned at creation and
 * by the list) — never the token itself. Authenticated by the PARENT token in
 * `x-credit-token`; a parent can only touch its own children.
 */

import { NextRequest, NextResponse } from "next/server";
import { setChildStatus, deleteChild } from "@/lib/fleet";
import { fleetGate, fleetErrorResponse } from "@/lib/fleet-http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const g = await fleetGate(req);
  if ("res" in g) return g.res;
  const { id } = await ctx.params;
  let status: unknown;
  try {
    status = ((await req.json()) as { status?: unknown })?.status;
  } catch {
    status = undefined;
  }
  if (status !== "paused" && status !== "active") {
    return NextResponse.json({ error: 'Send { "status": "paused" } or { "status": "active" }.' }, { status: 400 });
  }
  try {
    await setChildStatus(g.parent, id, status);
    return NextResponse.json({ id, status, effective: "on the child's next call" }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return fleetErrorResponse(err);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const g = await fleetGate(req);
  if ("res" in g) return g.res;
  const { id } = await ctx.params;
  try {
    await deleteChild(g.parent, id);
    return NextResponse.json({ id, deleted: true }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return fleetErrorResponse(err);
  }
}
