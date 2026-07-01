/**
 * Consumer Agent — an autonomous agent that *pays* for x402 Bazaar services like
 * a real client would. It calls the live paid endpoints over x402 (real on-chain
 * USDC settlement + Builder Code attribution), seeding genuine onchain usage and
 * populating /stats with paid calls. Dogfooding / liveness, not organic demand.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 * Needs: BUYER_PRIVATE_KEY (wallet with a little USDC on Base).
 */

import { NextRequest, NextResponse } from "next/server";
import { getPayingFetch, getBuyerAddress } from "@/lib/x402-client";
import { safeEqual } from "@/lib/secure";
import { kvIncr } from "@/lib/kv";
import { getConfig } from "@/lib/config";

// Hard safety ceiling on paid calls per day (normal usage ~4). Protects the
// buyer wallet if the cron is ever misconfigured to a high frequency.
const DAILY_CAP = 12;

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ORIGIN = (process.env.NEXT_PUBLIC_SITE_URL || "https://402.com.tr").replace(/\/$/, "");

// Real, legit Base tokens — varied, so usage looks like genuine market scanning.
const TOKENS = [
  "0x4200000000000000000000000000000000000006", // WETH
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
  "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", // DEGEN
  "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", // VIRTUAL
  "0x532f27101965dd16442E59d40670FaF5eBB142E4", // BRETT
  "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
];

// Cheap, address-parameterised services to rotate through (skip pricey AI here).
const SERVICES = ["token-risk", "token-price", "token-momentum", "holders", "rug-score"];

const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Master spend kill-switch: ENABLE_BUYER=false disables ALL buyer spending
  // (this cron included), so the buyer key can be neutralised with one env var.
  if (!getConfig().enableBuyer) {
    return NextResponse.json({ skipped: "spending disabled (ENABLE_BUYER=false)", settled: 0 });
  }

  let pay: ReturnType<typeof getPayingFetch>;
  try {
    pay = getPayingFetch();
  } catch {
    return NextResponse.json({ skipped: "BUYER_PRIVATE_KEY not configured", settled: 0 });
  }

  // 2 paid calls per run — enough to seed usage, cheap to sustain.
  const plan = [
    { service: pick(SERVICES), address: pick(TOKENS) },
    { service: pick(SERVICES), address: pick(TOKENS) },
  ];

  const day = new Date().toISOString().slice(0, 10);
  const results: Array<{ service: string; address: string; status: number | string }> = [];
  let settled = 0;
  for (const job of plan) {
    const spentToday = await kvIncr(`consumer:day:${day}`, 60 * 60 * 25);
    if (spentToday > DAILY_CAP) {
      results.push({ service: job.service, address: job.address, status: "daily-cap-reached" });
      break;
    }
    try {
      const res = await pay(`${ORIGIN}/api/x402/${job.service}?address=${job.address}`);
      results.push({ service: job.service, address: job.address, status: res.status });
      if (res.ok) settled++;
    } catch (e) {
      results.push({ service: job.service, address: job.address, status: e instanceof Error ? e.message.slice(0, 80) : "error" });
    }
  }

  return NextResponse.json({ buyer: getBuyerAddress(), settled, calls: results });
}
