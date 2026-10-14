/**
 * POST /api/workflows/run — run up to five paid calls in one request.
 *
 * Body: { template, input } or { steps: [{ service, params }] }, plus optional
 * `stopOnStop` (default true) and `dryRun`. Paid with the caller's prepaid
 * credit token (`x-credit-token`). See src/lib/workflows.ts for the rules.
 *
 * Every step is handed to the GET handler of /api/x402/[service] — the same
 * function a direct call reaches — with the caller's token, so each step is
 * debited, refunded and reported exactly as if the caller had made it alone.
 */

import { NextRequest, NextResponse } from "next/server";
import { GET as paidServiceGET } from "@/app/api/x402/[service]/route";
import { planWorkflow, quotePlan, runPlan, type PaidCaller } from "@/lib/workflows";
import { creditBalance, isCreditTokenShape } from "@/lib/credits";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
// Up to five paid calls run one after another, each allowed the paid route's own 60s.
export const maxDuration = 300;

const callPaidRoute: PaidCaller = (req, serviceId) => paidServiceGET(req, { params: Promise.resolve({ service: serviceId }) });

export async function POST(req: NextRequest) {
  const rl = await rateLimitKv(`wfrun:${clientIp(req)}`, 30, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 200_000) return NextResponse.json({ error: "Body too large" }, { status: 413 });
    body = JSON.parse(raw || "{}");
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const dryRun = !!body && typeof body === "object" && (body as { dryRun?: unknown }).dryRun === true;
  if (body && typeof body === "object" && !Array.isArray(body)) delete (body as { dryRun?: unknown }).dryRun;

  const planned = planWorkflow(body);
  if (!planned.ok) {
    return NextResponse.json({ error: planned.error, details: planned.details, charged: false }, { status: 400 });
  }
  const { plan } = planned;
  const quote = await quotePlan(plan, req);
  const token = (req.headers.get("x-credit-token") || "").trim();

  if (dryRun) {
    const balanceCents = isCreditTokenShape(token) ? await creditBalance(token) : null;
    return NextResponse.json({
      dryRun: true,
      charged: false,
      workflow: plan.name,
      stopOnStop: plan.stopOnStop,
      quote,
      ...(balanceCents !== null ? { creditBalanceUsd: balanceCents / 100, sufficient: balanceCents * 10 >= quote.totalMills } : {}),
    });
  }

  if (!isCreditTokenShape(token)) {
    return NextResponse.json(
      {
        error: "A workflow is paid from a prepaid credit token: send it as the x-credit-token header. Nothing was charged.",
        quote,
        buy: "/credits (or one x402 payment on /api/x402/buy-credits?tier=0.25|1|5|20)",
      },
      { status: 402 },
    );
  }

  // Refuse up front when the balance cannot cover the quote, rather than
  // charging the first steps of a run that cannot finish.
  const balanceCents = await creditBalance(token);
  if (balanceCents * 10 < quote.totalMills) {
    return NextResponse.json(
      {
        error: `Insufficient credits for this workflow: it costs $${quote.totalUsd.toFixed(3)} and the balance is $${(balanceCents / 100).toFixed(2)}. Nothing was charged.`,
        quote,
        creditBalanceUsd: balanceCents / 100,
        topUp: "/credits",
      },
      { status: 402 },
    );
  }

  const result = await runPlan(plan, req, token, callPaidRoute);
  return NextResponse.json({ quote, ...result }, { status: result.insufficientCredits ? 402 : 200 });
}
