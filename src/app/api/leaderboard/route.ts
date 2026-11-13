/**
 * Public leaderboard JSON: what outside payers actually bought, counted at
 * settlement from the signer's address with our own buyer excluded
 * (src/lib/keepalive-economics.ts). Counts only — no revenue, no addresses.
 */

import { NextResponse } from "next/server";
import { externalLeaderboard } from "@/lib/keepalive-economics";
import { snapshot } from "@/lib/snapshot";
import { SERVICES } from "@/lib/services";

// Live KV-backed counts: render on demand, never prerender at build. A build-time
// prerender calls Upstash, so a rate-limited KV turned a transient hiccup into a
// failed deploy (2026-11-06, HGETALL external:calls:svc). The Cache-Control header
// below still gives the CDN its 5-minute window.
export const dynamic = "force-dynamic";

export async function GET() {
  // Coalesced per instance (5 min) with a last-good fallback — a crawler storm
  // or a KV outage costs at most one read per window, never a 500.
  const snap = await snapshot("api:leaderboard", 300_000, externalLeaderboard);
  const lb = snap.value;
  const names = new Map(SERVICES.map((s) => [s.id, s.name]));
  return NextResponse.json(
    {
      ...lb,
      ...(snap.stale ? { stale: true, asOf: snap.at } : {}),
      services: lb.services.map((s) => ({ ...s, name: names.get(s.id) ?? s.id, listed: names.has(s.id) })),
      method:
        "Paid x402 calls whose signer is not our own buyer wallet, counted at settlement. Our keepalive/indexing purchases and unreadable payers are excluded. Prepaid-credit calls are not included.",
    },
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
  );
}
