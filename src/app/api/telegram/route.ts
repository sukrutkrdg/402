/**
 * Telegram bot webhook — the "Base Token Safety Bot".
 *
 * Send the bot a Base token address and it replies with a combined report
 * (risk + OFAC sanctions + price) computed by x402 Bazaar's own service
 * handlers. It's a free showcase that funnels users to 402.com.tr.
 *
 * Setup (run once, replace <TOKEN>/<SECRET>):
 *   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://402.com.tr/api/telegram&secret_token=<SECRET>
 *
 * Env: TELEGRAM_BOT_TOKEN (required), TELEGRAM_WEBHOOK_SECRET (recommended).
 */

import { NextRequest, NextResponse } from "next/server";
import { tokenRisk } from "@/lib/onchain";
import { tokenPrice } from "@/lib/onchain-extra";
import { sanctionsCheck } from "@/lib/compliance";

export const dynamic = "force-dynamic";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const SITE = "https://402.com.tr";

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function send(chatId: number, text: string) {
  if (!TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* best-effort */
  }
}

const WELCOME =
  "🛡️ <b>Base Token Safety Bot</b>\n\n" +
  "Send me any <b>Base token address</b> (0x…) and I'll return a risk + sanctions + price report.\n\n" +
  `Powered by <a href="${SITE}">x402 Bazaar</a> — pay-per-call APIs for agents.`;

function riskEmoji(level: unknown): string {
  return level === "low" ? "🟢" : level === "medium" ? "🟡" : "🔴";
}

async function buildReport(address: string): Promise<string> {
  const [risk, price, sanctions] = await Promise.allSettled([
    tokenRisk({ address }),
    tokenPrice({ address }),
    sanctionsCheck({ address }),
  ]);

  const lines: string[] = [`🔎 <b>Token report</b>\n<code>${esc(address)}</code>`];

  if (risk.status === "fulfilled") {
    const r = risk.value as {
      riskScore?: number;
      riskLevel?: string;
      flags?: string[];
      token?: { name?: string; symbol?: string };
    };
    const name = r.token?.symbol || r.token?.name;
    lines.push(
      `\n${riskEmoji(r.riskLevel)} <b>Risk:</b> ${esc(r.riskLevel ?? "?")} (${esc(r.riskScore ?? "?")}/100)` +
        (name ? ` · ${esc(name)}` : ""),
    );
    if (r.flags && r.flags.length) lines.push(`⚠️ ${r.flags.slice(0, 6).map(esc).join(", ")}`);
  } else {
    lines.push("\n• Risk: unavailable");
  }

  if (sanctions.status === "fulfilled") {
    const s = sanctions.value as { sanctioned?: boolean };
    lines.push(s.sanctioned ? "⛔ <b>OFAC sanctioned</b>" : "✅ Not OFAC-sanctioned");
  }

  if (price.status === "fulfilled") {
    const p = price.value as { priceUsd?: string; priceChange24h?: number | null; liquidityUsd?: number | null };
    if (p.priceUsd) {
      const chg = typeof p.priceChange24h === "number" ? ` (${p.priceChange24h > 0 ? "+" : ""}${p.priceChange24h}% 24h)` : "";
      const liq = typeof p.liquidityUsd === "number" ? ` · liq $${Math.round(p.liquidityUsd).toLocaleString()}` : "";
      lines.push(`💲 <b>$${esc(p.priceUsd)}</b>${esc(chg)}${esc(liq)}`);
    }
  }

  lines.push(`\n<a href="${SITE}/agents">Use these APIs in your agent →</a>`);
  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  if (!TOKEN) {
    return NextResponse.json({ error: "Bot not configured" }, { status: 503 });
  }
  // Verify Telegram's secret header (set via setWebhook secret_token).
  if (SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: { message?: { chat?: { id?: number }; text?: string } };
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true }); // ignore malformed updates
  }

  const chatId = update.message?.chat?.id;
  const text = (update.message?.text || "").trim();
  if (typeof chatId !== "number") return NextResponse.json({ ok: true });

  if (/^\/start|^\/help/i.test(text)) {
    await send(chatId, WELCOME);
    return NextResponse.json({ ok: true });
  }

  const match = text.match(/0x[0-9a-fA-F]{40}/);
  if (!match) {
    await send(chatId, "Send me a Base token address (0x…) and I'll check it. /help for info.");
    return NextResponse.json({ ok: true });
  }

  await send(chatId, await buildReport(match[0]));
  return NextResponse.json({ ok: true });
}
