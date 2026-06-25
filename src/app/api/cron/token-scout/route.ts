/**
 * Token Scout — an autonomous agent that runs on a schedule: it scans newly
 * listed Base tokens, scores each for rug risk using our own services, and posts
 * notable ones to a Telegram channel. "An agent that works for you 24/7."
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 * Env:  TELEGRAM_BOT_TOKEN (reused), TELEGRAM_SCOUT_CHAT (channel/chat id to post to)
 */

import { NextRequest, NextResponse } from "next/server";
import { newTokens } from "@/lib/onchain-extra4";
import { rugScore } from "@/lib/scores";
import { safeEqual } from "@/lib/secure";
import { kvGet, kvSet } from "@/lib/kv";

export const dynamic = "force-dynamic";

const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_SCOUT_CHAT;

async function post(text: string) {
  if (!BOT || !CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* best-effort */
  }
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!BOT || !CHAT) {
    return NextResponse.json({ skipped: "TELEGRAM_SCOUT_CHAT not configured", posted: 0 });
  }

  let tokens: Array<{ tokenAddress?: string | null; description?: string | null }> = [];
  try {
    const data = (await newTokens({})) as { tokens?: typeof tokens };
    tokens = data.tokens ?? [];
  } catch {
    return NextResponse.json({ error: "new-tokens unavailable", posted: 0 });
  }

  let posted = 0;
  for (const t of tokens.slice(0, 8)) {
    const addr = t.tokenAddress;
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;

    // Dedup — don't repost the same token (7-day memory).
    const seenKey = `scout:seen:${addr.toLowerCase()}`;
    if (await kvGet(seenKey)) continue;
    await kvSet(seenKey, "1", 60 * 60 * 24 * 7);

    type Scored = {
      rugScore?: number;
      level?: string;
      signals?: string[];
      inputs?: { liquidityUsd?: number | null };
    };
    let scored: Scored | null = null;
    try {
      scored = (await rugScore({ address: addr })) as unknown as Scored;
    } catch {
      scored = null;
    }

    // Signal gate — only post what's worth a subscriber's attention:
    //   a high rug risk (warning value) OR meaningful liquidity (worth knowing).
    // Everything else is noise and is skipped (kept in seen-set so we don't recheck).
    const liq = scored?.inputs?.liquidityUsd ?? 0;
    const notable = Boolean(scored) && (scored!.level === "high" || liq >= 20000);
    if (!notable) continue;

    const emoji = scored?.level === "high" ? "🔴" : scored?.level === "medium" ? "🟡" : "🟢";
    const lines = [
      `🔭 <b>New Base token</b>`,
      `<code>${esc(addr)}</code>`,
      scored ? `${emoji} Rug score: <b>${esc(scored.rugScore)}/100</b> (${esc(scored.level)})` : "Rug score: n/a",
    ];
    if (liq > 0) lines.push(`💧 Liquidity: ~$${esc(Math.round(liq).toLocaleString())}`);
    if (scored?.signals?.length) lines.push(`⚠️ ${scored.signals.slice(0, 4).map(esc).join(", ")}`);
    if (t.description) lines.push(esc(String(t.description).slice(0, 140)));
    lines.push(`🔗 Check any token: <a href="https://t.me/Bazaar402_bot">@Bazaar402_bot</a> · 402.com.tr`);

    await post(lines.join("\n"));
    posted++;
    if (posted >= 4) break; // cap per run
  }

  return NextResponse.json({ scanned: tokens.length, posted });
}
