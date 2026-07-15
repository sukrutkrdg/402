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
import { newTokens } from "@/lib/onchain-extra4";
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

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Pick the single most cast-worthy token and compose its cast + embed. */
async function pickCast(dry: boolean): Promise<{ text: string; embed: string; token: string; kind: string } | null> {
  let tokens: Array<{ tokenAddress?: string | null; description?: string | null }> = [];
  try {
    const data = (await newTokens({})) as { tokens?: typeof tokens };
    tokens = data.tokens ?? [];
  } catch {
    return null;
  }

  for (const tk of tokens.slice(0, 20)) {
    const addr = tk.tokenAddress;
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
    const a = addr.toLowerCase();

    // 7-day dedup so we never cast the same token twice. In dry mode we don't
    // consume the dedup key (so a preview doesn't silently "use up" a token).
    const seenKey = `fcscout:seen:${a}`;
    if (await kvGet(seenKey)) continue;

    const embed = `${APP}?token=${addr}`;

    // Best content: a scam we caught before anyone aped in.
    const scam = await scamCheck(addr);
    if (scam?.isScam) {
      const sym = scam.symbol ? `$${scam.symbol}` : "This new Base token";
      const text = [
        `🚨 Caught ${scam.honeypot ? "a honeypot" : "an unsellable token"} on Base before anyone aped in`,
        ``,
        `${sym} — ${scam.reasons.slice(0, 2).join(" · ")}`,
        short(addr),
        ``,
        `Check any Base token before you buy 👇`,
      ].join("\n");
      if (!dry) await kvSet(seenKey, "1", 60 * 60 * 24 * 7);
      return { text, embed, token: addr, kind: "caught-scam" };
    }

    // Else: a genuinely high rug-risk token (warning value).
    let scored: Scored | null = null;
    try {
      scored = (await rugScore({ address: addr })) as unknown as Scored;
    } catch {
      scored = null;
    }
    if (scored?.level === "high") {
      const sym = tk.description ? String(tk.description).split(/[\s—·|]/)[0].slice(0, 16) : "";
      const text = [
        `🔴 High rug risk on a fresh Base token${sym ? ` (${sym})` : ""}`,
        ``,
        `Rug score ${scored.rugScore}/100${scored.signals?.length ? ` · ${scored.signals.slice(0, 2).join(", ")}` : ""}`,
        short(addr),
        ``,
        `Don't ape before you check 👇`,
      ].join("\n");
      if (!dry) await kvSet(seenKey, "1", 60 * 60 * 24 * 7);
      return { text, embed, token: addr, kind: "high-risk" };
    }
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
