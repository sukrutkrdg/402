/**
 * Farcaster agent — replies to casts that mention the bot with an AI token
 * report. Powered by Neynar. Env-gated: inactive until configured.
 *
 * Setup: create a Neynar app + managed signer, set the env vars below, and point
 * a Neynar "cast.created" webhook (filtered to mentions of your bot fid) here.
 *
 * Env: NEYNAR_API_KEY, NEYNAR_SIGNER_UUID, NEYNAR_WEBHOOK_SECRET (recommended).
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { aiTokenReport } from "@/lib/ai-report";
import { safeEqual } from "@/lib/secure";

export const dynamic = "force-dynamic";

const API_KEY = process.env.NEYNAR_API_KEY;
const SIGNER = process.env.NEYNAR_SIGNER_UUID;
const WEBHOOK_SECRET = process.env.NEYNAR_WEBHOOK_SECRET;

const VERDICT: Record<string, string> = {
  avoid: "🔴",
  high_caution: "🟠",
  caution: "🟡",
  neutral: "⚪",
  favorable: "🟢",
};

async function reply(parentHash: string, text: string) {
  if (!API_KEY || !SIGNER) return;
  try {
    await fetch("https://api.neynar.com/v2/farcaster/cast", {
      method: "POST",
      headers: { "x-api-key": API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ signer_uuid: SIGNER, text: text.slice(0, 1024), parent: parentHash }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* best-effort */
  }
}

export async function POST(req: NextRequest) {
  if (!API_KEY || !SIGNER) {
    return NextResponse.json({ error: "Farcaster bot not configured" }, { status: 503 });
  }

  // Webhook signature is mandatory — never process unauthenticated casts
  // (they trigger paid AI calls + outbound Neynar posts).
  if (!WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 503 });
  }
  const raw = await req.text();
  const sig = req.headers.get("x-neynar-signature") ?? "";
  const expected = createHmac("sha512", WEBHOOK_SECRET).update(raw).digest("hex");
  if (!safeEqual(sig, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { type?: string; data?: { hash?: string; text?: string } };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }
  if (body.type !== "cast.created") return NextResponse.json({ ok: true });

  const hash = body.data?.hash;
  const text = body.data?.text ?? "";
  const m = text.match(/0x[0-9a-fA-F]{40}/);
  if (!hash) return NextResponse.json({ ok: true });
  if (!m) {
    await reply(hash, "Send a Base token address (0x…) and I'll reply with an AI safety verdict. → 402.com.tr");
    return NextResponse.json({ ok: true });
  }

  try {
    const r = (await aiTokenReport({ address: m[0] })) as {
      verdict?: string;
      safetyScore?: number;
      summary?: string;
      risks?: string[];
    };
    const v = VERDICT[r.verdict ?? "neutral"] ?? "⚪";
    const label = (r.verdict ?? "?").replace(/_/g, " ").toUpperCase();
    const score = typeof r.safetyScore === "number" ? ` · safety ${r.safetyScore}/100` : "";
    const risks = (r.risks ?? []).slice(0, 2).map((x) => `⚠️ ${x}`).join("\n");
    const text = [
      `${v} ${label}${score}`,
      "",
      r.summary ?? "",
      ...(risks ? ["", risks] : []),
      "",
      "via x402 Bazaar · 402.com.tr",
    ].join("\n");
    await reply(hash, text);
  } catch (e) {
    await reply(hash, `Couldn't analyze that token right now. → 402.com.tr/agents`);
    void e;
  }
  return NextResponse.json({ ok: true });
}
