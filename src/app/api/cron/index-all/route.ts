/**
 * Index-All — one-time discovery seeding. Makes a single settled x402 payment to
 * each service so the CDP facilitator's Bazaar discovery layer indexes the whole
 * catalog (→ discoverable on Agentic.Market / x402scan). Run once; cheap.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 * Needs: BUYER_PRIVATE_KEY (a little USDC on Base).
 */

import { NextRequest, NextResponse } from "next/server";
import { getPayingFetch } from "@/lib/x402-client";
import { safeEqual } from "@/lib/secure";
import { SERVICES } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ORIGIN = (process.env.NEXT_PUBLIC_SITE_URL || "https://402.com.tr").replace(/\/$/, "");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const recentDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

// Resolve a valid sample value per known param name. Unknown → null (skip service).
function sample(name: string): string | null {
  switch (name) {
    case "address":
    case "token":
    case "contract":
      return USDC;
    case "addresses":
      return `${USDC},${WETH}`;
    case "date":
      return recentDate;
    case "text":
      return "x402 Bazaar is a pay-per-call API marketplace on Base for AI agents.";
    case "lang":
    case "language":
    case "target":
      return "Spanish";
    case "selector":
      return "0xa9059cbb";
    case "name":
      return "jesse.base.eth";
    default:
      return null; // e.g. tx "hash" — can't reliably sample; skip
  }
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let pay: ReturnType<typeof getPayingFetch>;
  try {
    pay = getPayingFetch();
  } catch {
    return NextResponse.json({ skipped: "BUYER_PRIVATE_KEY not configured" });
  }

  const results: Array<{ service: string; status: number | string }> = [];
  let indexed = 0;
  for (const s of SERVICES) {
    // Build sample params; skip the service if a required param can't be sampled.
    const params: Record<string, string> = {};
    let skip = false;
    for (const p of s.params) {
      const v = sample(p.name);
      if (v === null) {
        if (p.required) skip = true;
      } else {
        params[p.name] = v;
      }
    }
    if (skip) {
      results.push({ service: s.id, status: "skipped-no-sample" });
      continue;
    }
    const qs = new URLSearchParams(params).toString();
    try {
      const res = await pay(`${ORIGIN}/api/x402/${s.id}${qs ? `?${qs}` : ""}`);
      results.push({ service: s.id, status: res.status });
      if (res.ok) indexed++;
    } catch (e) {
      results.push({ service: s.id, status: e instanceof Error ? e.message.slice(0, 60) : "error" });
    }
  }

  return NextResponse.json({ indexed, total: SERVICES.length, results });
}
