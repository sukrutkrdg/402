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
import { kvGet, kvSet } from "@/lib/kv";
import { getConfig } from "@/lib/config";

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

  // Master spend kill-switch: ENABLE_BUYER=false disables ALL buyer spending.
  if (!getConfig().enableBuyer) {
    return NextResponse.json({ skipped: "spending disabled (ENABLE_BUYER=false)", indexed: 0 });
  }

  let pay: ReturnType<typeof getPayingFetch>;
  try {
    pay = getPayingFetch();
  } catch {
    return NextResponse.json({ skipped: "BUYER_PRIVATE_KEY not configured" });
  }

  // Cap paid settlements per invocation so the function returns under the
  // serverless timeout (each x402 settlement takes a few seconds). Re-run until
  // remaining = 0; the KV skip makes it idempotent.
  const MAX_PER_RUN = 2;
  // Optional ?only=id1,id2 → index just those services (skips earlier erroring ones).
  const only = (new URL(req.url).searchParams.get("only") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Default: skip metered-upstream services (Covalent/Alchemy) so our own
  // indexing round-trip never burns paid API credits. They get discovered
  // organically on the first real external payment, or force via ?only=<id>.
  const pool = only.length
    ? SERVICES.filter((s) => only.includes(s.id))
    : SERVICES.filter((s) => !s.noFreeTier);
  const results: Array<{ service: string; status: number | string }> = [];
  let indexed = 0;
  let attempts = 0;
  for (const s of pool) {
    if (attempts >= MAX_PER_RUN) {
      results.push({ service: s.id, status: "deferred-next-run" });
      continue;
    }
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
    // Idempotent: don't re-pay a service already indexed (lets you re-run to finish).
    if (await kvGet(`idx:${s.id}`)) {
      results.push({ service: s.id, status: "already-indexed" });
      continue;
    }
    const qs = new URLSearchParams(params).toString();
    attempts++;
    try {
      const res = await pay(`${ORIGIN}/api/x402/${s.id}${qs ? `?${qs}` : ""}`);
      results.push({ service: s.id, status: res.status });
      if (res.ok) {
        indexed++;
        await kvSet(`idx:${s.id}`, "1", 60 * 60 * 24 * 30); // 30-day memory
      }
    } catch (e) {
      results.push({ service: s.id, status: e instanceof Error ? e.message.slice(0, 60) : "error" });
    }
  }

  return NextResponse.json({ indexed, total: SERVICES.length, results });
}
