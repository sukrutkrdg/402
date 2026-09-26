/**
 * Service health as JSON, for agents choosing whether to call us: per service,
 * calls, success rate (our failures only — a refused input is the caller's),
 * and median / 90th-percentile latency over the last 7 days, from real calls.
 */

import { NextResponse } from "next/server";
import { readHealth } from "@/lib/health";
import { SERVICES } from "@/lib/services";

export const revalidate = 300;

export async function GET() {
  const h = await readHealth(7);
  const visible = new Set(SERVICES.filter((s) => !s.hidden).map((s) => s.id));
  const services = h.services.filter((s) => visible.has(s.service)).sort((a, b) => b.calls - a.calls);
  const ok = services.reduce((s, x) => s + x.ok, 0);
  const fail = services.reduce((s, x) => s + x.fail, 0);
  return NextResponse.json(
    {
      window: { from: h.from, to: h.to, days: 7 },
      overall: { calls: services.reduce((s, x) => s + x.calls, 0), successPct: ok + fail ? +((ok / (ok + fail)) * 100).toFixed(1) : null },
      method: "Recorded on every handler run. successPct = answered ÷ (answered + our failures); a refused input (400) is the caller's and not counted. Latency is the bucket holding the median / 90th-percentile answered call.",
      services,
      notCalledThisWeek: [...visible].filter((id) => !services.some((s) => s.service === id)).sort(),
    },
    { headers: { "cache-control": "public, max-age=60, s-maxage=300" } },
  );
}
