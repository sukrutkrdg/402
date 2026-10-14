/**
 * Token Scout — an autonomous agent that runs on a schedule: it scans newly
 * listed Base tokens, scores each for rug risk using our own services, and posts
 * notable ones to a Telegram channel. "An agent that works for you 24/7."
 *
 * Every token it actually scans is also recorded (src/lib/live-events.ts,
 * `scout:results`) exactly as computed — sell-side flags, rug-score level/score/
 * signals, which sources answered and which did not, and the EAS attestation tx
 * when one was published — for /radar, the live feed and /api/scout/latest.
 * Recording is best-effort and can never break the run.
 *
 * Scanning and recording run whether or not Telegram is configured; posting and
 * the EAS attestation (which always accompanied a public post) need Telegram.
 *
 * Schedule (vercel.json): every 4h at :15 — "15 0,4,8,12,16,20 * * *", 6 runs/day (was
 * once a day). Cost per run, upper bound: 3 feed calls (GeckoTerminal + 2
 * DexScreener) + up to 20 tokens × ~11 upstream calls (2 GoPlus — our direct
 * sell-side check plus the 90s-cached one shared by token-risk/holders — ~8 Base
 * RPC reads, 1 DexScreener) ≈ 225 calls, and ~9 KV commands per token (seen
 * marker, upstream caches, LPUSH/LTRIM/EXPIRE of the record) ≈ 180. Per day:
 * ≈ 1,350 free-tier upstream calls and ≈ 1,100 KV commands — the per-run burst
 * (≈ 40 GoPlus calls, sequential) is unchanged, only spread over more runs.
 * Side effects scale too: at most 4 Telegram posts and 4 EAS attestations
 * (Base gas, fractions of a cent each) per run, so ≤ 24/day instead of ≤ 4.
 * Tokens are deduped for 7 days, so more runs mean fresher scans, not rescans.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 * Env:  TELEGRAM_BOT_TOKEN (reused), TELEGRAM_SCOUT_CHAT (channel/chat id to post to)
 */

import { NextRequest, NextResponse } from "next/server";
import { newTokens } from "@/lib/onchain-extra4";
import { rugScore } from "@/lib/scores";
import { safeEqual } from "@/lib/secure";
import { kvGet, kvSet } from "@/lib/kv";
import { attestScam } from "@/lib/eas-attest";
import { recordScan, type ScanInput } from "@/lib/live-events";

export const dynamic = "force-dynamic";

/** Tokens scanned per run at most (after the 7-day seen-dedup). */
const SCOUT_MAX_SCANS = 20;
/** Telegram posts per run at most. */
const SCOUT_MAX_POSTS = 4;

function telegram() {
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_SCOUT_CHAT;
  return bot && chat ? { bot, chat } : null;
}

async function post(tg: { bot: string; chat: string }, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${tg.bot}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* best-effort */
  }
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// GoPlus sell-side security — the signals that prove a scam (caught it before you aped in).
interface Scam {
  isScam: boolean;
  symbol: string | null;
  reasons: string[];
  honeypot: boolean;
  sellTax: number | null;
  buyTax: number | null;
}
async function scamCheck(address: string): Promise<Scam | null> {
  try {
    const res = await fetch(
      `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: Record<string, Record<string, unknown>> };
    const gp = j.result?.[address.toLowerCase()];
    if (!gp || Object.keys(gp).length === 0) return null;
    const t = (v: unknown) => v === 1 || v === "1" || v === true;
    const n = (v: unknown) => {
      const x = parseFloat(String(v ?? ""));
      return Number.isFinite(x) ? x : null;
    };
    const sellTaxRaw = n(gp.sell_tax);
    const buyTaxRaw = n(gp.buy_tax);
    const sellTax = sellTaxRaw !== null ? Math.round(sellTaxRaw * 100) : null;
    const buyTax = buyTaxRaw !== null ? Math.round(buyTaxRaw * 100) : null;
    const reasons: string[] = [];
    if (t(gp.is_honeypot)) reasons.push("honeypot — you can buy but not sell");
    if (t(gp.cannot_sell_all)) reasons.push("can't sell your full balance");
    if (sellTax !== null && sellTax >= 30) reasons.push(`${sellTax}% sell tax — you keep little on exit`);
    if (t(gp.is_blacklisted)) reasons.push("owner can blacklist your wallet");
    if (t(gp.transfer_pausable)) reasons.push("owner can pause transfers (freeze exit)");
    if (t(gp.is_mintable)) reasons.push("owner can mint unlimited supply");
    const isScam = t(gp.is_honeypot) || t(gp.cannot_sell_all) || (sellTax !== null && sellTax >= 30);
    return { isScam, symbol: (gp.token_symbol as string) || null, reasons, honeypot: t(gp.is_honeypot), sellTax, buyTax };
  } catch {
    return null;
  }
}

type Scored = {
  rugScore?: number;
  level?: string;
  degraded?: boolean;
  signals?: string[];
  sources?: string[];
  sourcesMissing?: string[];
  inputs?: { liquidityUsd?: number | null };
};

/** The scan record, built only from what this scan computed. */
function scanRecord(addr: string, scam: Scam | null, scored: Scored | null, rugRan: boolean, attestationTx: string | null): ScanInput {
  const sources: string[] = scam ? ["goplus-sell-side"] : [];
  const sourcesMissing: string[] = scam ? [] : ["goplus-sell-side"];
  if (scored) {
    sources.push(...(scored.sources ?? []));
    sourcesMissing.push(...(scored.sourcesMissing ?? []));
  } else if (rugRan) {
    sourcesMissing.push("rug-score");
  }
  const verdict: ScanInput["verdict"] = scam?.isScam ? "sell_side_flags" : scored ? "scored" : "not_scored";
  return {
    token: addr,
    symbol: scam?.symbol ?? null,
    verdict,
    level: scored && typeof scored.level === "string" ? scored.level : null,
    score: scored && typeof scored.rugScore === "number" ? scored.rugScore : null,
    sellSideFlags: scam?.reasons ?? [],
    riskSignals: scored?.signals ?? [],
    sources,
    sourcesMissing,
    // A sell-side hit is a complete answer for what it claims; otherwise the scan
    // is degraded when the rug score could not run or itself reported degraded.
    degraded: verdict === "sell_side_flags" ? false : scored ? scored.degraded === true : true,
    attestationTx,
  };
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tg = telegram();

  let tokens: Array<{ tokenAddress?: string | null; description?: string | null }> = [];
  try {
    const data = (await newTokens({})) as { tokens?: typeof tokens };
    tokens = data.tokens ?? [];
  } catch {
    return NextResponse.json({ error: "new-tokens unavailable", posted: 0, recorded: 0 });
  }

  let posted = 0;
  let recorded = 0;
  let scannedNow = 0;
  const record = async (input: ScanInput) => {
    try {
      if (await recordScan(input)) recorded++;
    } catch {
      /* recording must never break the scout */
    }
  };

  for (const t of tokens.slice(0, SCOUT_MAX_SCANS)) {
    const addr = t.tokenAddress;
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;

    // Dedup — don't repost the same token (7-day memory).
    const seenKey = `scout:seen:${addr.toLowerCase()}`;
    if (await kvGet(seenKey)) continue;
    await kvSet(seenKey, "1", 60 * 60 * 24 * 7);
    scannedNow++;

    // FIRST: is it an outright scam we can showcase catching? (honeypot / can't-sell
    // / extreme tax). This is the marketing gold — "we caught it before you aped in".
    const scam = await scamCheck(addr);
    if (scam?.isScam) {
      let att: Awaited<ReturnType<typeof attestScam>> = null;
      if (tg) {
        const sym = scam.symbol ? `$${esc(scam.symbol)}` : "This new token";
        const scamType = scam.honeypot ? "honeypot" : scam.reasons[0]?.includes("sell tax") ? "extreme_tax" : "unsellable";
        // Publish a verifiable on-chain attestation to Base EAS (best-effort).
        att = await attestScam({ token: addr, symbol: scam.symbol, scamType, reasons: scam.reasons });
        const caught = [
          `🚨 <b>CAUGHT: ${scam.honeypot ? "honeypot" : "unsellable token"} on Base</b>`,
          ``,
          `${sym} — flagged before you could ape in.`,
          ...scam.reasons.slice(0, 4).map((r) => `🔴 ${esc(r)}`),
          `<code>${esc(addr)}</code>`,
          ``,
          ...(att ? [`📜 On-chain proof: <a href="${esc(att.scanUrl)}">Base EAS attestation</a>`] : []),
          `x402 Bazaar flagged this in one call. Check ANY Base token before you buy 👇`,
          `402.com.tr/app · <a href="https://t.me/Bazaar402_bot">@Bazaar402_bot</a>`,
        ];
        await post(tg, caught.join("\n"));
        posted++;
      }
      await record(scanRecord(addr, scam, null, false, att?.txHash ?? null));
      if (posted >= SCOUT_MAX_POSTS) break;
      continue;
    }

    let scored: Scored | null = null;
    try {
      scored = (await rugScore({ address: addr })) as unknown as Scored;
    } catch {
      scored = null;
    }
    await record(scanRecord(addr, scam, scored, true, null));

    // Signal gate — only post what's worth a subscriber's attention:
    //   a high rug risk (warning value) OR meaningful liquidity (worth knowing).
    // Everything else is noise and is skipped (kept in seen-set so we don't recheck).
    const liq = scored?.inputs?.liquidityUsd ?? 0;
    // Only post genuinely high-risk tokens — no clean-token noise. The channel is
    // a risk/scam feed, not a new-listing firehose. (CAUGHT scams are handled above.)
    const notable = Boolean(scored) && scored!.level === "high";
    if (!notable || !tg) continue;

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

    await post(tg, lines.join("\n"));
    posted++;
    if (posted >= SCOUT_MAX_POSTS) break; // cap per run
  }

  return NextResponse.json({
    scanned: tokens.length,
    scannedNow,
    recorded,
    posted,
    ...(tg ? {} : { telegram: "not configured — scanned and recorded, nothing posted" }),
  });
}
