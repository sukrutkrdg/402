/**
 * Public leaderboard JSON: what outside payers actually bought, counted at
 * settlement from the signer's address with our own buyer excluded
 * (src/lib/keepalive-economics.ts). Counts only — no revenue, no addresses.
 */

import { NextResponse } from "next/server";
import { externalLeaderboard } from "@/lib/keepalive-economics";
import { SERVICES } from "@/lib/services";

export const revalidate = 300;

export async function GET() {
  const lb = await externalLeaderboard();
  const names = new Map(SERVICES.map((s) => [s.id, s.name]));
  return NextResponse.json(
    {
      ...lb,
      services: lb.services.map((s) => ({ ...s, name: names.get(s.id) ?? s.id, listed: names.has(s.id) })),
      method:
        "Paid x402 calls whose signer is not our own buyer wallet, counted at settlement. Our keepalive/indexing purchases and unreadable payers are excluded. Prepaid-credit calls are not included.",
    },
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
  );
}
