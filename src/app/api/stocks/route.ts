/**
 * The public board for Coinbase's tokenized equities on Base. Free, no payment.
 *
 * Everything else in this catalogue is paid, and this one deliberately is not.
 * The claim it makes — that `balanceOf` is not the share count — is only worth
 * anything if anyone can check it without buying something first. A paywalled
 * proof convinces nobody.
 *
 * The paid surface stays where it belongs: `stock-position` answers the question
 * for a specific wallet, which is the part an agent actually needs and the part
 * that costs us RPC reads per caller.
 *
 * Cached for a minute. The underlying facts move on the order of weeks (the last
 * six equities were issued on 2026-09-03, the four before them on 2026-08-12),
 * and a multiplier change is caught by cron/stock-actions, not by whoever
 * happens to load this page.
 */

import { NextResponse } from "next/server";
import { readStockBoard } from "@/lib/tokenized-stocks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const board = await readStockBoard();
  return NextResponse.json(board, {
    headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}
