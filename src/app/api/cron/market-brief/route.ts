/**
 * Daily Market Brief — an autonomous content agent: once a day it generates an
 * AI Market Brief and posts it to the Telegram channel. Keeps the channel fresh
 * and doubles as zero-effort distribution.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 * Env:  TELEGRAM_BOT_TOKEN, TELEGRAM_SCOUT_CHAT, ANTHROPIC_API_KEY
 */

import { NextRequest, NextResponse } from "next/server";
import { aiMarketBrief } from "@/lib/ai-report";
import { safeEqual } from "@/lib/secure";
import { kvIncr } from "@/lib/kv";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_SCOUT_CHAT;
const NEYNAR_KEY = process.env.NEYNAR_API_KEY;
const NEYNAR_SIGNER = process.env.NEYNAR_SIGNER_UUID;

// Post the brief to Farcaster (the user's account) — best-effort.
async function postCast(text: string): Promise<boolean> {
  if (!NEYNAR_KEY || !NEYNAR_SIGNER) return false;
  try {
    const r = await fetch("https://api.neynar.com/v2/farcaster/cast", {
      method: "POST",
      headers: { "x-api-key": NEYNAR_KEY, "content-type": "application/json" },
      body: JSON.stringify({ signer_uuid: NEYNAR_SIGNER, text: text.slice(0, 1000) }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MOOD: Record<string, string> = {
  bullish: "🟢",
  active: "🔵",
  mixed: "⚪",
  quiet: "⚫",
  risky: "🔴",
};

async function post(text: string): Promise<boolean> {
  if (!BOT || !CHAT) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!BOT || !CHAT) {
    return NextResponse.json({ skipped: "TELEGRAM_SCOUT_CHAT not configured", posted: false });
  }

  let r: Awaited<ReturnType<typeof aiMarketBrief>>;
  try {
    r = await aiMarketBrief({});
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "brief failed", posted: false });
  }

  const block = (title: string, items: string[]) =>
    items.length ? `\n<b>${title}</b>\n${items.slice(0, 4).map((x) => "• " + esc(x)).join("\n")}` : "";

  const text = [
    `🗞️ <b>Base Market Brief</b>`,
    `${MOOD[r.mood] ?? "⚪"} Mood: <b>${esc(r.mood)}</b>`,
    r.summary ? `\n${esc(r.summary)}` : "",
    block("Highlights", r.highlights ?? []),
    block("New &amp; notable", r.newAndNotable ?? []),
    block("⚠️ Cautions", r.cautions ?? []),
    `\n<i>Powered by x402 Bazaar · 402.com.tr</i>`,
  ]
    .filter(Boolean)
    .join("\n");

  const posted = await post(text);

  // ── Farcaster cross-post: quality-gated + once per calendar day ──
  // Skip thin/quiet days so the personal account never posts low-value casts.
  const substance = (r.highlights?.length ?? 0) + (r.newAndNotable?.length ?? 0) + (r.cautions?.length ?? 0);
  const worthCasting = r.mood !== "quiet" && substance >= 2;
  let casted = false;
  let castSkipped = "not-substantive";
  if (worthCasting && NEYNAR_KEY && NEYNAR_SIGNER) {
    const day = new Date().toISOString().slice(0, 10);
    const n = await kvIncr(`fcbrief:${day}`, 60 * 60 * 25); // 1 cast/day max
    if (n === 1) {
      const line = (emoji: string, items?: string[]) => (items && items[0] ? `\n${emoji} ${items[0]}` : "");
      const cast = [
        `🗞️ Base Market Brief`,
        ``,
        `${MOOD[r.mood] ?? "⚪"} ${r.mood}${r.summary ? ` — ${r.summary}` : ""}`,
        line("🔥", r.highlights),
        line("🆕", r.newAndNotable),
        line("⚠️", r.cautions),
        ``,
        `via x402 Bazaar · 402.com.tr`,
      ].join("\n");
      casted = await postCast(cast);
      castSkipped = casted ? "" : "post-failed";
    } else {
      castSkipped = "already-cast-today";
    }
  }

  return NextResponse.json({ posted, casted, castSkipped, mood: r.mood });
}
