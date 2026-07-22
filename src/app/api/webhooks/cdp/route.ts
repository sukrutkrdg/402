/**
 * CDP Webhooks receiver — powers B20 Guard.
 *
 * One network-wide CDP webhook subscription (event_name=PolicyUpdated, plus
 * Paused/Unpaused) POSTs here the moment ANY B20 token changes a policy slot —
 * i.e. the moment a token can become seizable. We store a compact record in KV;
 * the b20-guard service reads it to answer "did this token just turn seizable?"
 * and to serve a recently-turned-seizable feed.
 *
 * Auth: the subscription's target URL carries ?key=${CDP_WEBHOOK_SECRET}. The
 * exact CDP delivery payload shape isn't pinned by docs, so parsing is
 * defensive: we accept single events or arrays and look for common field names.
 */

import { NextRequest, NextResponse } from "next/server";
import { kvLPush, kvSet, kvIncr } from "@/lib/kv";
import { safeEqual } from "@/lib/secure";
import { getAddress } from "viem";
import { isB20Token } from "@/lib/b20-safety";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface Rec {
  token: string;
  event: string;
  time: string;
  scopeTopic: string | null;
  oldPolicyId: string | null;
  newPolicyId: string | null;
  txHash: string | null;
}

// Best-effort extraction across possible CDP payload shapes.
function extract(e: Record<string, unknown>): Rec | null {
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      const v = k.split(".").reduce<unknown>((o, p) => (o && typeof o === "object" ? (o as Record<string, unknown>)[p] : undefined), e);
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  };
  const token = String(pick("contract_address", "contractAddress", "address", "data.contract_address", "data.address") ?? "");
  const event = String(pick("event_name", "eventName", "data.event_name", "event_signature", "data.event_signature") ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !event) return null;
  if (!/Policy|Paused/i.test(event)) return null; // only guard-relevant events
  const params = (pick("parameters", "data.parameters") ?? {}) as Record<string, unknown>;
  const topics = (pick("topics", "data.topics") ?? []) as unknown[];
  // Length-cap every free-form field before storing: webhook payloads are
  // authenticated but external input, and these values are later served (and
  // sampled) — no legitimate value here exceeds a bytes32/tx-hash length.
  const cap = (v: string | null) => (v === null ? null : v.slice(0, 128));
  return {
    token: token.toLowerCase(),
    event: event.split("(")[0].slice(0, 128),
    time: String(pick("block_timestamp", "blockTimestamp", "timestamp", "data.block_timestamp") ?? new Date().toISOString()).slice(0, 128),
    scopeTopic: typeof topics[1] === "string" ? cap(topics[1] as string) : null,
    oldPolicyId: params.oldPolicyId != null ? cap(String(params.oldPolicyId)) : null,
    newPolicyId: params.newPolicyId != null ? cap(String(params.newPolicyId)) : null,
    txHash: cap((pick("transaction_hash", "transactionHash", "data.transaction_hash") as string) ?? null),
  };
}

export async function POST(req: NextRequest) {
  const secret = process.env.CDP_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "receiver not configured" }, { status: 503 });
  const provided = req.nextUrl.searchParams.get("key") ?? "";
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // Accept a single event, {events:[...]}, or a raw array.
  const list: Record<string, unknown>[] = Array.isArray(body)
    ? (body as Record<string, unknown>[])
    : Array.isArray((body as Record<string, unknown>)?.events)
      ? ((body as Record<string, unknown>).events as Record<string, unknown>[])
      : [body as Record<string, unknown>];

  // CDP's webhook model authenticates via the target-URL secret only (no HMAC over
  // the body), so if that secret ever leaks through logs an attacker could POST
  // fabricated seizure events. Two defenses before we store anything served to
  // b20-guard customers: (1) replay/dedup so a repeated event isn't re-stored, and
  // (2) confirm the token is a GENUINE B20 on-chain (B20Factory) — this rejects
  // forged events for arbitrary/non-B20 addresses.
  let stored = 0;
  let skipped = 0;
  for (const e of list.slice(0, 20)) {
    const rec = extract(e);
    if (!rec) continue;

    // Replay guard: fingerprint the event; skip if already processed recently.
    const fp = `${rec.token}:${rec.txHash ?? ""}:${rec.event}:${rec.newPolicyId ?? ""}:${rec.scopeTopic ?? ""}`;
    const seen = await kvIncr(`b20guard:seen:${fp}`, 60 * 60 * 24 * 2);
    if (seen !== null && seen > 1) { skipped++; continue; }

    // Authenticity: only store events for a real B20 (defeats forged addresses).
    let real = false;
    try { real = await isB20Token(getAddress(rec.token)); } catch { real = false; }
    if (!real) { skipped++; continue; }

    const json = JSON.stringify(rec);
    await kvLPush("b20guard:events", json, 300); // network-wide feed
    await kvLPush(`b20guard:token:${rec.token}`, json, 30); // per-token history
    await kvSet(`b20guard:latest:${rec.token}`, json, 60 * 60 * 24 * 45);
    stored++;
  }

  return NextResponse.json({ ok: true, stored, skipped });
}
