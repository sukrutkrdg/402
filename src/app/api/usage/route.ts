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
  const nameById = Object.fromEntries(SERVICES.map((s) => [s.id, s.name]));
  const priceById = Object.fromEntries(
    SERVICES.map((s) => [s.id, parseFloat(s.price.replace(/[^0-9.]/g, "")) || 0]),
  );

  // Enrich each service row: display name, unit price, estimated revenue
  // (paid × price), and conversion rate (paid ÷ external non-internal calls) —
  // so the dashboard shows which services actually make money and which give
  // their value away for free.
  const per = data.per.map((r) => {
    const price = priceById[r.id] ?? 0;
    const external = Math.max(0, r.total - r.internal); // strip our own first-party calls
    return {
      ...r,
      name: nameById[r.id] ?? r.id,
      price,
      revenue: +(r.paid * price).toFixed(4),
      conversionPct: external > 0 ? +((r.paid / external) * 100).toFixed(1) : 0,
    };
  });
  const totalRevenue = +per.reduce((a, r) => a + r.revenue, 0).toFixed(2);

  return NextResponse.json({
    ...data,
    youSource,
    ownerSources: cfg.ownerSources,
    totalRevenue,
    per,
    recent: data.recent.map((r) => ({ ...r, name: nameById[r.s] ?? r.s })),
  });
}
