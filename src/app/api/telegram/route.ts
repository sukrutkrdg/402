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
import { aiTokenReport, aiWalletReport, aiMarketBrief } from "@/lib/ai-report";
import { walletPortfolio, nftFloor } from "@/lib/alchemy";
import { walletNetworth } from "@/lib/covalent";
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

// Inline buttons appended to report replies — site, agent docs, and a share link.
const REPORT_BUTTONS = {
  inline_keyboard: [
    [
      { text: "🌐 402.com.tr", url: SITE },
      { text: "🤖 For agents", url: `${SITE}/agents` },
    ],
    [{ text: "🔗 Share this bot", url: "https://t.me/Bazaar402_bot" }],
  ],
};

async function send(chatId: number, text: string, withButtons = false) {
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
        ...(withButtons ? { reply_markup: REPORT_BUTTONS } : {}),
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
  "Commands: /scan · /ai (token verdict) · /market (Base market brief) · /networth · /wallet · /portfolio · /nft · /recent · /help\n\n" +
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

const VERDICT_EMOJI: Record<string, string> = {
  avoid: "🔴",
  high_caution: "🟠",
  caution: "🟡",
  neutral: "⚪",
  favorable: "🟢",
};

async function buildNetworth(address: string): Promise<string> {
  let r: Awaited<ReturnType<typeof walletNetworth>>;
  try {
    r = await walletNetworth({ address });
  } catch (e) {
    return `⚠️ ${esc(e instanceof Error ? e.message : "Net worth failed")}`;
  }
  const L: string[] = [`🏦 <b>Wallet Net Worth</b>`, `<code>${esc(address)}</code>`];
  L.push(`\n<b>Total: $${esc(r.totalUsd)}</b> · ${r.tokenCount} tokens`);
  for (const h of r.holdings.slice(0, 10)) {
    const bal = Number(h.balance).toLocaleString(undefined, { maximumFractionDigits: 4 });
    L.push(`• ${esc(h.symbol || "?")}: ${esc(bal)}${h.usdValue != null ? ` ($${esc(h.usdValue)})` : ""}`);
  }
  if (r.holdings.length === 0) L.push("No token holdings found.");
  L.push(`\n<a href="${SITE}/agents">Wallet Net Worth API →</a>`);
  return L.join("\n");
}

const WALLET_VERDICT: Record<string, string> = {
  fresh_or_risky: "🔴",
  new: "🟠",
  normal: "⚪",
  established: "🟢",
  power_user: "🟢",
};

const MOOD: Record<string, string> = {
  bullish: "🟢",
  active: "🔵",
  mixed: "⚪",
  quiet: "⚫",
  risky: "🔴",
};

async function buildMarketBrief(): Promise<string> {
  let r: Awaited<ReturnType<typeof aiMarketBrief>>;
  try {
    r = await aiMarketBrief({});
  } catch (e) {
    return `⚠️ ${esc(e instanceof Error ? e.message : "Market brief failed")}`;
  }
  const L: string[] = [`🗞️ <b>AI Market Brief — Base</b>`, `${MOOD[r.mood] ?? "⚪"} Mood: <b>${esc(r.mood)}</b>`];
  if (r.summary) L.push(`\n${esc(r.summary)}`);
  if (r.highlights?.length) L.push(`\n<b>Highlights</b>\n${r.highlights.slice(0, 4).map((x) => "• " + esc(x)).join("\n")}`);
  if (r.newAndNotable?.length) L.push(`\n<b>New &amp; notable</b>\n${r.newAndNotable.slice(0, 4).map((x) => "• " + esc(x)).join("\n")}`);
  if (r.cautions?.length) L.push(`\n<b>⚠️ Cautions</b>\n${r.cautions.slice(0, 4).map((x) => "• " + esc(x)).join("\n")}`);
  L.push(`\n<a href="${SITE}/agents">AI Market Brief API →</a>`);
  return L.join("\n");
}

async function buildWalletReport(address: string): Promise<string> {
  let r: Awaited<ReturnType<typeof aiWalletReport>>;
  try {
    r = await aiWalletReport({ address });
  } catch (e) {
    return `⚠️ ${esc(e instanceof Error ? e.message : "Wallet report failed")}`;
  }
  const L: string[] = [`🧠 <b>AI Wallet Report</b>`, `<code>${esc(address)}</code>`];
  L.push(`\n${WALLET_VERDICT[r.verdict] ?? "⚪"} <b>${esc(r.verdict)}</b>`);
  if (r.summary) L.push(esc(r.summary));
  if (r.observations?.length)
    L.push(`\n${r.observations.slice(0, 5).map((x) => "• " + esc(x)).join("\n")}`);
  L.push(`\n<a href="${SITE}/agents">AI Wallet Report API →</a>`);
  return L.join("\n");
}

async function buildAiReport(address: string): Promise<string> {
  let r: Awaited<ReturnType<typeof aiTokenReport>>;
  try {
    r = await aiTokenReport({ address });
  } catch (e) {
    return `⚠️ ${esc(e instanceof Error ? e.message : "AI report failed")}`;
  }
  const L: string[] = [`🔬 <b>AI Token Report</b>`, `<code>${esc(address)}</code>`];
  L.push(`\n${VERDICT_EMOJI[r.verdict] ?? "⚪"} <b>Verdict:</b> ${esc(r.verdict)}`);
  if (r.summary) L.push(esc(r.summary));
  const d = r.data as {
    risk?: { riskScore?: number } | null;
    holders?: { top10Pct?: number } | null;
    price?: { liquidityUsd?: number | null } | null;
  };
  const facts: string[] = [];
  if (typeof d.risk?.riskScore === "number") facts.push(`risk ${d.risk.riskScore}/100`);
  if (typeof d.holders?.top10Pct === "number") facts.push(`top10 ${d.holders.top10Pct}%`);
  if (typeof d.price?.liquidityUsd === "number")
    facts.push(`liq $${Math.round(d.price.liquidityUsd).toLocaleString()}`);
  if (facts.length) L.push(`📊 ${facts.join(" · ")}`);
  if (r.risks?.length) L.push(`\n⚠️ <b>Risks</b>\n${r.risks.slice(0, 5).map((x) => "• " + esc(x)).join("\n")}`);
  if (r.positives?.length)
    L.push(`\n✅ <b>Positives</b>\n${r.positives.slice(0, 5).map((x) => "• " + esc(x)).join("\n")}`);
  L.push(`\n<a href="${SITE}/agents">AI Token Report API →</a>`);
  return L.join("\n");
}

async function buildPortfolio(address: string): Promise<string> {
  let r: Awaited<ReturnType<typeof walletPortfolio>>;
  try {
    r = await walletPortfolio({ address });
  } catch (e) {
    return `⚠️ ${esc(e instanceof Error ? e.message : "Portfolio failed")}`;
  }
  const L: string[] = [`💰 <b>Wallet Portfolio</b>`, `<code>${esc(address)}</code>`];
  L.push(`\n<b>Total: $${esc(r.totalUsd)}</b> · ${r.tokenCount} tokens`);
  for (const h of r.holdings.slice(0, 8)) {
    const bal = Number(h.balance).toLocaleString(undefined, { maximumFractionDigits: 4 });
    L.push(`• ${esc(h.symbol || "?")}: ${esc(bal)}${h.usdValue != null ? ` ($${esc(h.usdValue)})` : ""}`);
  }
  if (r.holdings.length === 0) L.push("No token holdings found.");
  L.push(`\n<a href="${SITE}/agents">Wallet Portfolio API →</a>`);
  return L.join("\n");
}

async function buildNft(contract: string): Promise<string> {
  let r: Awaited<ReturnType<typeof nftFloor>>;
  try {
    r = await nftFloor({ contract });
  } catch (e) {
    return `⚠️ ${esc(e instanceof Error ? e.message : "NFT floor failed")}`;
  }
  const L: string[] = [`🖼️ <b>NFT Floor Price</b>`, `<code>${esc(contract)}</code>`];
  if (r.floorPriceEth != null) L.push(`\n💎 Floor: <b>${esc(r.floorPriceEth)} ETH</b>`);
  if (r.openSea) L.push(`OpenSea: ${esc(r.openSea.floorPrice)} ${esc(r.openSea.currency)}`);
  if (r.looksRare) L.push(`LooksRare: ${esc(r.looksRare.floorPrice)} ${esc(r.looksRare.currency)}`);
  L.push(`\n<a href="${SITE}/agents">NFT Floor API →</a>`);
  return L.join("\n");
}

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

  if (/^\/ai\b/i.test(text)) {
    const m = text.match(/0x[0-9a-fA-F]{40}/);
    if (!m) {
      await send(chatId, "Usage: <code>/ai 0x…</code> — Claude-written due-diligence verdict for a token.");
      return NextResponse.json({ ok: true });
    }
    // /ai calls Claude (real cost) — cap per chat per day.
    const day = new Date().toISOString().slice(0, 10);
    if ((await kvIncr(`tg:ai:${chatId}:${day}`, 86400)) > 15) {
      await send(chatId, "Daily /ai limit reached (15). Use /scan for a free instant report anytime.");
      return NextResponse.json({ ok: true });
    }
    await send(chatId, await buildAiReport(m[0]), true);
    return NextResponse.json({ ok: true });
  }

  if (/^\/portfolio\b/i.test(text)) {
    const m = text.match(/0x[0-9a-fA-F]{40}/);
    await send(chatId, m ? await buildPortfolio(m[0]) : "Usage: <code>/portfolio 0x…</code> — full wallet holdings + USD.", Boolean(m));
    return NextResponse.json({ ok: true });
  }

  if (/^\/nft\b/i.test(text)) {
    const m = text.match(/0x[0-9a-fA-F]{40}/);
    await send(chatId, m ? await buildNft(m[0]) : "Usage: <code>/nft 0x…</code> — floor price for an NFT collection.", Boolean(m));
    return NextResponse.json({ ok: true });
  }

  if (/^\/networth\b/i.test(text)) {
    const m = text.match(/0x[0-9a-fA-F]{40}/);
    await send(chatId, m ? await buildNetworth(m[0]) : "Usage: <code>/networth 0x…</code> — full wallet net worth in USD.", Boolean(m));
    return NextResponse.json({ ok: true });
  }

  if (/^\/wallet\b/i.test(text)) {
    const m = text.match(/0x[0-9a-fA-F]{40}/);
    if (!m) {
      await send(chatId, "Usage: <code>/wallet 0x…</code> — Claude-written profile of a wallet.");
      return NextResponse.json({ ok: true });
    }
    const day = new Date().toISOString().slice(0, 10);
    if ((await kvIncr(`tg:ai:${chatId}:${day}`, 86400)) > 15) {
      await send(chatId, "Daily AI limit reached (15). Use /networth for a free instant breakdown.");
      return NextResponse.json({ ok: true });
    }
    await send(chatId, await buildWalletReport(m[0]), true);
    return NextResponse.json({ ok: true });
  }

  if (/^\/market\b/i.test(text)) {
    const day = new Date().toISOString().slice(0, 10);
    if ((await kvIncr(`tg:ai:${chatId}:${day}`, 86400)) > 15) {
      await send(chatId, "Daily AI limit reached (15). Try again tomorrow.");
      return NextResponse.json({ ok: true });
    }
    await send(chatId, await buildMarketBrief(), true);
    return NextResponse.json({ ok: true });
  }

  const match = text.match(/0x[0-9a-fA-F]{40}/);
  if (!match) {
    await send(chatId, "Send me a Base token address (0x…) and I'll check it. /help for info.");
    return NextResponse.json({ ok: true });
  }

  await send(chatId, await buildReport(match[0]), true);
  return NextResponse.json({ ok: true });
}
