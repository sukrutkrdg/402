/**
 * GET /api/workflows — the built-in workflow templates, each with a quote.
 *
 * GET /api/workflows?template=pre-buy&quote=1&address=0x…  → a quote for that
 * template with those inputs. Nothing is called or charged; prices come from the
 * same function the paid route charges by. Run it with POST /api/workflows/run.
 */

import { NextRequest, NextResponse } from "next/server";
import { TEMPLATES, MAX_STEPS, planWorkflow, quotePlan } from "@/lib/workflows";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rl = await rateLimitKv(`wfq:${clientIp(req)}`, 60, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  const url = new URL(req.url);
  const template = url.searchParams.get("template");
  if (template) {
    const input: Record<string, string> = {};
    for (const [k, v] of url.searchParams) if (k !== "template" && k !== "quote") input[k] = v;
    const planned = planWorkflow({ template, input });
    if (!planned.ok) return NextResponse.json({ error: planned.error, details: planned.details }, { status: 400 });
    const quote = await quotePlan(planned.plan, req);
    return NextResponse.json({ template, input, quote, charged: false });
  }

  const templates = await Promise.all(
    TEMPLATES.map(async (t) => {
      // Quoted before anyone has typed an input: required inputs get a stand-in
      // value (none of these templates' prices depends on one — quotePlan marks
      // a step inexact when it does), optional ones are left out as in a run.
      const planned = planWorkflow({ template: t.id, input: Object.fromEntries(t.inputs.filter((i) => i.required).map((i) => [i.name, "x"])) });
      return {
        ...t,
        quote: planned.ok ? await quotePlan(planned.plan, req) : null,
      };
    }),
  );

  return NextResponse.json({
    templates,
    run: {
      method: "POST",
      url: "/api/workflows/run",
      payment:
        "Send your prepaid credit token as the x-credit-token header. Each step is a call to /api/x402/<service> with that token and is debited exactly like a direct call: a step whose handler fails is refunded, and steps after a failure, an empty balance or (with stopOnStop) a STOP decision are not called and not charged.",
      body: {
        template: "pre-buy",
        input: { address: "0x…" },
        stopOnStop: true,
        dryRun: false,
      },
      custom: {
        steps: [
          { service: "token-risk", params: { address: "0x…" } },
          { service: "sellability", params: { address: "$1.data.address" } },
        ],
      },
      maxSteps: MAX_STEPS,
      references:
        'A parameter may be "$input.<name>" (a workflow input) or "$<N>.<path>" (a string/number/boolean from step N\'s JSON response, e.g. "$1.data.address"). Paths follow own fields and array indexes only. Write "$$" for a literal "$".',
    },
  });
}
