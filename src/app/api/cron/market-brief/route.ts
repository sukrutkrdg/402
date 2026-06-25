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

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_SCOUT_CHAT;

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
  return NextResponse.json({ posted, mood: r.mood });
}
