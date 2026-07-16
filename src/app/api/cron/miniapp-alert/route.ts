/**
 * Mini-app retention notification — pushes a Farcaster notification to every
 * user who added the mini app when something genuinely notable happened on
 * Base in the last 24h: B20 tokens that ATTACHED a seize/blocklist policy
 * (turnedSeizable — holders can now be burnBlocked). No event → no send; this
 * channel must never become noise.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} (same as farcaster-scout).
 * Preview safely first: GET ...?dry=1 → shows what it WOULD send, sends nothing.
 * Idempotent per day: notificationId is date-stamped and a KV flag skips re-runs.
 */

import { NextRequest, NextResponse } from "next/server";
import { keccak256, toBytes } from "viem";
import { cdpSql } from "@/lib/covalent";
import { safeEqual } from "@/lib/secure";
import { kvGet, kvSet } from "@/lib/kv";
import { sendToAll, notifTargetCount } from "@/lib/miniapp-notify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const APP_URL = "https://402.com.tr/app?mode=wallet";
// The seize-enabling scope (same derivation as b20-safety.ts).
const SENDER_POLICY = keccak256(toBytes("TRANSFER_SENDER_POLICY")).toLowerCase();

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const day = new Date().toISOString().slice(0, 10);

  if (!dry && (await kvGet(`fcalert:sent:${day}`))) {
    return NextResponse.json({ sent: false, reason: "already sent today" });
  }

  // B20 tokens that attached a sender blocklist (= became seizable) in 24h.
  const rows = await cdpSql<{ address?: string; topics?: string[]; parameters?: { newPolicyId?: string } }>(
    `SELECT address, topics, parameters
     FROM base.events
     WHERE event_name = 'PolicyUpdated'
       AND block_timestamp > now() - INTERVAL 24 HOUR
     ORDER BY block_timestamp DESC
     LIMIT 100`,
  );
  if (rows === null) return NextResponse.json({ sent: false, reason: "policy feed unavailable" }, { status: 502 });

  const turned = new Set<string>();
  for (const r of rows) {
    if (r.topics?.[1]?.toLowerCase() !== SENDER_POLICY) continue;
    const pid = r.parameters?.newPolicyId;
    if (pid && pid !== "0" && r.address) turned.add(r.address.toLowerCase());
  }

  const targets = await notifTargetCount();
  if (turned.size === 0) {
    return NextResponse.json({ sent: false, reason: "no B20 turned seizable in 24h", targets });
  }

  const n = turned.size;
  const title = "B20 seize alert";
  const body = `${n} Base token${n === 1 ? "" : "s"} attached a seize/blocklist policy in the last 24h. Scan your wallet for exposure.`;
  const notificationId = `b20-seize-${day}`;

  if (dry) {
    return NextResponse.json({ sent: false, dry: true, wouldSend: { notificationId, title, body, targetUrl: APP_URL }, tokensTurned: [...turned], targets });
  }

  const result = await sendToAll(notificationId, title, body, APP_URL);
  await kvSet(`fcalert:sent:${day}`, JSON.stringify({ at: new Date().toISOString(), turned: n, ...result }), 60 * 60 * 48);
  return NextResponse.json({ sent: true, notificationId, turned: n, ...result });
}
