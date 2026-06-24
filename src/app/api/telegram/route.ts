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
import { kvLPush, kvLRange, kvIncr } from "@/lib/kv";
import { safeEqual } from "@/lib/secure";
import { rateLimit } from "@/lib/rate-limit";

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
  "Send me any <b>Base token address</b> (0x…) — or <code>/scan 0x…</code> in groups — and I'll return a risk + sanctions + price report.\n\n" +
  "Commands: /scan &lt;address&gt; · /recent · /help\n\n" +
  `Powered by <a href="${SITE}">x402 Bazaar</a> — pay-per-call APIs for agents.`;

async function recordScan(address: string, symbol: string) {
  try {
    await kvLPush("bot:recent", JSON.stringify({ a: address, s: (symbol || "").slice(0, 20), t: Date.now() }), 50);
  } catch {
    /* best-effort */
  }
}

async function recentList(): Promise<string> {
  let rows: string[] = [];
  try {
    rows = await kvLRange("bot:recent", 0, 7);
  } catch {
    /* ignore */
  }
  const items = rows
    .map((r) => {
      try {
        return JSON.parse(r) as { a: string; s: string };
      } catch {
        return null;
      }
    })
    .filter((x): x is { a: string; s: string } => x !== null);
  if (items.length === 0) return "No tokens scanned yet. Send me a Base token address to start.";
  const lines = items.map(
    (it) => `• ${it.s ? `<b>${esc(it.s)}</b> — ` : ""}<code>${esc(it.a)}</code>`,
  );
  return `🕘 <b>Recently scanned</b>\n${lines.join("\n")}`;
}

function riskEmoji(level: unknown): string {
  return level === "low" ? "🟢" : level === "medium" ? "🟡" : "🔴";
}

interface RiskValue {
  riskScore?: number;
  riskLevel?: string;
  flags?: string[];
  upgradeableProxy?: boolean;
  token?: { name?: string | null; symbol?: string | null; decimals?: number | null };
  ownership?: { renounced?: boolean | null };
  security?: {
    isHoneypot?: boolean;
    buyTaxPct?: number | null;
    sellTaxPct?: number | null;
    isOpenSource?: boolean | null;
    holderCount?: number | null;
    topHolderPct?: number | null;
    top10HolderPct?: number | null;
    lockedLpPct?: number | null;
  } | null;
}
interface PriceValue {
  priceUsd?: string;
  priceChange24h?: number | null;
  liquidityUsd?: number | null;
  volume24h?: number | null;
  baseToken?: { name?: string | null; symbol?: string | null };
}

const n = (x: unknown) => (typeof x === "number" ? Math.round(x).toLocaleString() : null);

async function buildReport(address: string): Promise<string> {
  const [risk, price, sanctions] = await Promise.allSettled([
    tokenRisk({ address }),
    tokenPrice({ address }),
    sanctionsCheck({ address }),
  ]);

  const r = risk.status === "fulfilled" ? (risk.value as RiskValue) : null;
  const p = price.status === "fulfilled" ? (price.value as PriceValue) : null;

  // Title: name (SYMBOL)
  const name = r?.token?.name || p?.baseToken?.name || "";
  const symbol = r?.token?.symbol || p?.baseToken?.symbol || "";
  const title = name && symbol ? `${esc(name)} (${esc(symbol)})` : esc(name || symbol || "Token");
  void recordScan(address, symbol || name);

  const L: string[] = [`🔎 <b>${title}</b>`, `<code>${esc(address)}</code>`];

  // Risk + security details
  if (r) {
    L.push(`\n${riskEmoji(r.riskLevel)} <b>Risk:</b> ${esc(r.riskLevel ?? "?")} (${esc(r.riskScore ?? "?")}/100)`);
    const s = r.security;
    if (s) {
      if (s.isHoneypot) L.push("🍯 <b>HONEYPOT</b> — sells may be blocked");
      const det: string[] = [];
      if (n(s.holderCount)) det.push(`👥 ${n(s.holderCount)} holders`);
      if (typeof s.top10HolderPct === "number") det.push(`Top10 ${s.top10HolderPct}%`);
      if (typeof s.lockedLpPct === "number") det.push(`LP locked ${s.lockedLpPct}%`);
      if (det.length) L.push(det.join(" · "));
      if (typeof s.buyTaxPct === "number" || typeof s.sellTaxPct === "number") {
        L.push(`💸 Tax: buy ${esc(s.buyTaxPct ?? "?")}% / sell ${esc(s.sellTaxPct ?? "?")}%`);
      }
      if (s.isOpenSource === true) L.push("📄 Verified source");
      else if (s.isOpenSource === false) L.push("📄 Unverified source");
    }
    if (r.ownership?.renounced === true) L.push("🔓 Ownership renounced");
    if (r.upgradeableProxy) L.push("♻️ Upgradeable proxy");
    if (r.flags?.length) L.push(`⚠️ ${r.flags.slice(0, 6).map(esc).join(", ")}`);
  } else {
    L.push("\n• Risk: unavailable");
  }

  // Sanctions
  if (sanctions.status === "fulfilled") {
    const sc = sanctions.value as { sanctioned?: boolean };
    L.push(sc.sanctioned ? "⛔ <b>OFAC sanctioned</b>" : "✅ Not OFAC-sanctioned");
  }

  // Price
  if (p?.priceUsd) {
    const chg = typeof p.priceChange24h === "number" ? ` (${p.priceChange24h > 0 ? "+" : ""}${p.priceChange24h}% 24h)` : "";
    const liq = n(p.liquidityUsd) ? ` · Liq $${n(p.liquidityUsd)}` : "";
    const vol = n(p.volume24h) ? ` · Vol $${n(p.volume24h)}` : "";
    L.push(`💲 <b>$${esc(p.priceUsd)}</b>${esc(chg)}${esc(liq)}${esc(vol)}`);
  }

  L.push(`\n🔗 <a href="https://basescan.org/token/${esc(address)}">BaseScan</a> · <a href="${SITE}/agents">Use these APIs in your agent →</a>`);
  return L.join("\n");
}

export async function POST(req: NextRequest) {
  // Secret is MANDATORY — without it the webhook would accept anyone's POST.
  if (!TOKEN || !SECRET) {
    return NextResponse.json({ error: "Bot not configured" }, { status: 503 });
  }
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: { update_id?: number; message?: { chat?: { id?: number }; text?: string } };
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true }); // ignore malformed updates
  }

  const chatId = update.message?.chat?.id;
  const text = (update.message?.text || "").trim();
  if (typeof chatId !== "number") return NextResponse.json({ ok: true });

  // Per-chat rate limit (blunt abuse — each scan fans out to RPC/GoPlus/DexScreener).
  if (!rateLimit(`tg:${chatId}`, 12, 60_000).ok) {
    await send(chatId, "⏳ Rate limit — please wait a minute.");
    return NextResponse.json({ ok: true });
  }

  // Dedupe Telegram retries (it resends if we don't 200 within 5s) by update_id.
  if (typeof update.update_id === "number") {
    const seen = await kvIncr(`tg:upd:${update.update_id}`, 300);
    if (seen > 1) return NextResponse.json({ ok: true });
  }

  if (/^\/start|^\/help/i.test(text)) {
    await send(chatId, WELCOME);
    return NextResponse.json({ ok: true });
  }

  if (/^\/recent/i.test(text)) {
    await send(chatId, await recentList());
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
