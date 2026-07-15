/**
 * Farcaster Scout — the organic top-of-funnel for the Base App mini-app.
 *
 * On a schedule it finds a NOTABLE new Base token (an outright scam we caught, or
 * a high rug-risk token), then casts a real verdict to Farcaster with the mini-app
 * embedded as `402.com.tr/app?token=<addr>`. A tap opens the mini app already on
 * that token's free check — every cast is a funnel entry that can convert to an
 * on-chain (leaderboard-counting) paid check.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 * Env:  NEYNAR_API_KEY, NEYNAR_SIGNER_UUID (posting); shares token-scout's sources.
 * Preview safely first: GET ...?dry=1  → returns what it WOULD cast, posts nothing.
 */

import { NextRequest, NextResponse } from "next/server";
import { rugScore } from "@/lib/scores";
import { safeEqual } from "@/lib/secure";
import { kvGet, kvSet } from "@/lib/kv";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const API_KEY = process.env.NEYNAR_API_KEY;
const SIGNER = process.env.NEYNAR_SIGNER_UUID;
const APP = "https://402.com.tr/app";

/** Publish a top-level cast with the mini-app embed. Returns the new cast hash. */
async function cast(text: string, embedUrl: string): Promise<string | null> {
  if (!API_KEY || !SIGNER) return null;
  try {
    const r = await fetch("https://api.neynar.com/v2/farcaster/cast", {
      method: "POST",
      headers: { "x-api-key": API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ signer_uuid: SIGNER, text: text.slice(0, 320), embeds: [{ url: embedUrl }] }),
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { cast?: { hash?: string } };
    return j.cast?.hash ?? "posted";
  } catch {
    return null;
  }
}

interface Scam {
  isScam: boolean;
  symbol: string | null;
  reasons: string[];
  honeypot: boolean;
  sellTax: number | null;
}
async function scamCheck(address: string): Promise<Scam | null> {
  try {
    const res = await fetch(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address}`, {
      signal: AbortSignal.timeout(8000),
    });
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
    const sellTax = sellTaxRaw !== null ? Math.round(sellTaxRaw * 100) : null;
    const reasons: string[] = [];
    if (t(gp.is_honeypot)) reasons.push("honeypot — you can buy but not sell");
    if (t(gp.cannot_sell_all)) reasons.push("can't sell your full balance");
    if (sellTax !== null && sellTax >= 30) reasons.push(`${sellTax}% sell tax on exit`);
    if (t(gp.transfer_pausable)) reasons.push("owner can freeze transfers");
    if (t(gp.is_mintable)) reasons.push("owner can mint unlimited supply");
    const isScam = t(gp.is_honeypot) || t(gp.cannot_sell_all) || (sellTax !== null && sellTax >= 30);
    return { isScam, symbol: (gp.token_symbol as string) || null, reasons, honeypot: t(gp.is_honeypot), sellTax };
  } catch {
    return null;
  }
}

type Scored = { rugScore?: number; level?: string; signals?: string[] };
interface Trend { address: string; symbol: string; liq: number }

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Trending Base tokens = GeckoTerminal's actually-traded pools (trending by
 * activity + top by 24h volume). Real demand, not obscure fresh launches. Each
 * carries its symbol + liquidity so the picker needs no extra upstream call. */
async function trendingBaseTokens(): Promise<Trend[]> {
  const urls = [
    "https://api.geckoterminal.com/api/v2/networks/base/trending_pools?duration=24h",
    "https://api.geckoterminal.com/api/v2/networks/base/pools?sort=h24_volume_usd_desc",
  ];
  const seen = new Set<string>();
  const out: Trend[] = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(9000), headers: { accept: "application/json" } });
      if (!r.ok) continue;
      const j = (await r.json()) as {
        data?: Array<{ attributes?: { name?: string; reserve_in_usd?: string }; relationships?: { base_token?: { data?: { id?: string } } } }>;
      };
      for (const p of j.data ?? []) {
        const id = p.relationships?.base_token?.data?.id ?? ""; // "base_0x…"
        const addr = id.startsWith("base_") ? id.slice(5) : "";
        if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || seen.has(addr.toLowerCase())) continue;
        seen.add(addr.toLowerCase());
        const symbol = (p.attributes?.name ?? "").split("/")[0].trim().slice(0, 12);
        const liq = Math.round(parseFloat(p.attributes?.reserve_in_usd ?? "0")) || 0;
        out.push({ address: addr, symbol, liq });
      }
    } catch {
      /* best-effort */
    }
  }
  return out;
}

/** Pick a trending, liquid Base token and compose its safety-readout cast. Works
 * for ANY risk level (clean or risky) — the token is already something people
 * trade, so a verdict + "check it yourself" is a valid funnel entry every run. */
async function pickCast(dry: boolean): Promise<{ text: string; embed: string; token: string; kind: string } | null> {
  const candidates = await trendingBaseTokens();

  for (const c of candidates.slice(0, 30)) {
    if (c.liq < 10_000) continue; // skip dust — not worth a follower's tap
    const a = c.address.toLowerCase();
    // 7-day dedup so we rotate through tokens. Dry runs don't consume the key.
    const seenKey = `fcscout:seen:${a}`;
    if (await kvGet(seenKey)) continue;

    // Deterministic safety readout (no LLM cost on a schedule).
    let scored: Scored | null = null;
    try {
      scored = (await rugScore({ address: c.address })) as unknown as Scored;
    } catch {
      scored = null;
    }
    if (!scored) continue;
    const scam = await scamCheck(c.address);

    const level = scored.level ?? "?";
    const emoji = level === "high" ? "🔴" : level === "medium" ? "🟡" : "🟢";
    const signal = scam?.honeypot
      ? " · 🚨 HONEYPOT (can't sell)"
      : scored.signals?.length
        ? ` · ${scored.signals[0]}`
        : "";
    const embed = `${APP}?token=${c.address}`;
    const text = [
      `${emoji} ${c.symbol ? `$${c.symbol}` : "This token"} is trending on Base — safety readout 🛡️`,
      ``,
      `Rug score ${scored.rugScore}/100 (${level})${signal}`,
      `Liq ~$${c.liq.toLocaleString("en-US")} · ${short(c.address)}`,
      ``,
      `Check any Base token yourself 👇`,
    ].join("\n");
    if (!dry) await kvSet(seenKey, "1", 60 * 60 * 24 * 7);
    return { text, embed, token: c.address, kind: `trending-${level}` };
  }
  return null;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const configured = Boolean(API_KEY && SIGNER);
  const dry = new URL(req.url).searchParams.get("dry") === "1";

  if (!configured) {
    return NextResponse.json({
      configured: false,
      needs: ["NEYNAR_API_KEY", "NEYNAR_SIGNER_UUID"].filter((k) => !process.env[k]),
      posted: false,
    });
  }

  const chosen = await pickCast(dry);
  if (!chosen) {
    return NextResponse.json({ configured: true, dry, posted: false, note: "No cast-worthy new token this run." });
  }

  if (dry) {
    return NextResponse.json({ configured: true, dry: true, posted: false, wouldCast: chosen });
  }

  const hash = await cast(chosen.text, chosen.embed);
  return NextResponse.json({ configured: true, dry: false, posted: Boolean(hash), castHash: hash, cast: chosen });
}
