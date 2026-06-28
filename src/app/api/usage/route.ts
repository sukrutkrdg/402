/** Per-service usage analytics — OWNER ONLY (STATS_TOKEN gated). */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getUsage, srcHash } from "@/lib/usage";
import { SERVICES } from "@/lib/services";
import { safeEqual } from "@/lib/secure";
import { clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  // Header only — never accept the token in the query string (it leaks into logs).
  const provided = req.headers.get("x-stats-token") || "";

  if (!cfg.statsToken) {
    return NextResponse.json({ error: "Locked. Set STATS_TOKEN to enable." }, { status: 503 });
  }
  if (!safeEqual(provided, cfg.statsToken)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const data = await getUsage(SERVICES.map((s) => s.id), cfg.ownerSources);
  // The source hash of whoever is viewing /stats right now → UI can highlight "you".
  const youSource = srcHash(clientIp(req));
  // attach display names
  const nameById = Object.fromEntries(SERVICES.map((s) => [s.id, s.name]));
  return NextResponse.json({
    ...data,
    youSource,
    ownerSources: cfg.ownerSources,
    per: data.per.map((r) => ({ ...r, name: nameById[r.id] ?? r.id })),
    recent: data.recent.map((r) => ({ ...r, name: nameById[r.s] ?? r.s })),
  });
}
