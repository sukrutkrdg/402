/**
 * Paying wallets for a given day — OWNER ONLY (STATS_TOKEN gated).
 *
 * Reads the authoritative on-chain record: USDC Transfer events INTO the seller
 * wallet on the chosen date (CDP SQL over base.events), aggregated by payer
 * address so the owner can pick a date and see exactly which agent wallets bought,
 * how much, how many times, and drill into each transaction. Enriched with the
 * "first service this wallet bought" from our own usage log (keyed by the same
 * source hash we already record) so a wallet row tells a small story, not just a
 * number.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig, USDC_BASE } from "@/lib/config";
import { safeEqual } from "@/lib/secure";
import { cdpSql } from "@/lib/covalent";
import { kvGet } from "@/lib/kv";
import { srcHash } from "@/lib/usage";
import { SERVICES } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface EventRow {
  block_timestamp?: string;
  transaction_hash?: string;
  parameters?: { from?: string; to?: string; value?: string };
}

const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const nextDay = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const provided = req.headers.get("x-stats-token") || "";
  if (!cfg.statsToken) {
    return NextResponse.json({ error: "Locked. Set STATS_TOKEN to enable." }, { status: 503 });
  }
  if (!safeEqual(provided, cfg.statsToken)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!cfg.payTo) {
    return NextResponse.json({ error: "PAY_TO_ADDRESS not configured." }, { status: 503 });
  }

  const url = new URL(req.url);
  const date = (url.searchParams.get("date") || new Date().toISOString().slice(0, 10)).trim();
  if (!isYmd(date)) {
    return NextResponse.json({ error: "Pass date=YYYY-MM-DD." }, { status: 400 });
  }
  const payTo = cfg.payTo.toLowerCase();
  const usdc = USDC_BASE.toLowerCase();

  // USDC transfers INTO the seller wallet on this UTC day. parameters are Variants,
  // so both the address filter and the value need toString() before comparison/cast.
  const rows = await cdpSql<EventRow>(
    `SELECT block_timestamp, transaction_hash, parameters
     FROM base.events
     WHERE address = '${usdc}'
       AND event_signature = 'Transfer(address,address,uint256)'
       AND lower(toString(parameters['to'])) = '${payTo}'
       AND block_timestamp >= '${date} 00:00:00'
       AND block_timestamp < '${nextDay(date)} 00:00:00'
     ORDER BY block_timestamp DESC
     LIMIT 1000`,
  );

  if (rows === null) {
    return NextResponse.json(
      { date, available: false, note: "On-chain payer data needs CDP SQL (CDP_API_KEY_ID/SECRET). Falling back to the live revenue reader on /stats." },
      { status: 200 },
    );
  }

  const nameById = Object.fromEntries(SERVICES.map((s) => [s.id, s.name]));
  const toUsdc = (raw: string) => {
    try {
      // USDC has 6 decimals; keep it exact-ish for display.
      return +(Number(BigInt(raw || "0")) / 1e6).toFixed(2);
    } catch {
      return 0;
    }
  };

  interface Wallet {
    wallet: string;
    txCount: number;
    totalUsdc: number;
    firstAt: string | null;
    lastAt: string | null;
    txs: { txHash: string | null; usdc: number; at: string | null }[];
  }
  const byWallet = new Map<string, Wallet>();
  let totalUsdc = 0;

  for (const r of rows) {
    const from = (r.parameters?.from ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(from)) continue;
    const usd = toUsdc(r.parameters?.value ?? "0");
    totalUsdc += usd;
    const at = r.block_timestamp ?? null;
    const w =
      byWallet.get(from) ??
      ({ wallet: from, txCount: 0, totalUsdc: 0, firstAt: at, lastAt: at, txs: [] } as Wallet);
    w.txCount += 1;
    w.totalUsdc = +(w.totalUsdc + usd).toFixed(2);
    if (at && (!w.lastAt || at > w.lastAt)) w.lastAt = at;
    if (at && (!w.firstAt || at < w.firstAt)) w.firstAt = at;
    if (w.txs.length < 50) w.txs.push({ txHash: r.parameters ? r.transaction_hash ?? null : null, usdc: usd, at });
    byWallet.set(from, w);
  }

  // Enrich each wallet with the first service it ever bought (from our usage log,
  // keyed by the same hash we store on paid calls). Best-effort — never blocks.
  const wallets = await Promise.all(
    [...byWallet.values()]
      .sort((a, b) => b.totalUsdc - a.totalUsdc)
      .map(async (w) => {
        let firstService: string | null = null;
        try {
          // Lowercase to match the write side (route.ts lowercases before hashing).
          const svc = await kvGet(`usage:firstsvc:${srcHash(w.wallet.toLowerCase())}`);
          if (svc) firstService = nameById[svc] ?? svc;
        } catch {
          /* ignore */
        }
        return { ...w, firstService };
      }),
  );

  return NextResponse.json({
    date,
    available: true,
    payTo: cfg.payTo,
    walletCount: wallets.length,
    txCount: rows.length,
    totalUsdc: +totalUsdc.toFixed(2),
    wallets,
    note: "Authoritative on-chain USDC receipts into the seller wallet for this UTC day (CDP-indexed). Includes any direct transfers, not only x402 settlements.",
  });
}
