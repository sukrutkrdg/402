/**
 * Farcaster Mini App webhook — receives lifecycle events when users add/remove
 * the mini app or toggle notifications, and stores/deletes their notification
 * tokens (see src/lib/miniapp-notify.ts). Declared as `webhookUrl` in
 * /.well-known/farcaster.json.
 *
 * Events arrive as a JSON Farcaster Signature: base64url header/payload/signature,
 * signed with the client's app key (ed25519) over `${header}.${payload}`.
 * We verify that signature (proves possession of the stated key). We do NOT
 * additionally check the key against the onchain Key Registry — worst case a
 * forger registers their own URL and receives our (public) notification text;
 * growth is capped and per-IP rate-limited.
 */

import { NextRequest, NextResponse } from "next/server";
import { ed25519 } from "@noble/curves/ed25519";
import { saveNotifTarget, removeNotifTarget } from "@/lib/miniapp-notify";
import { kvIncr } from "@/lib/kv";

export const dynamic = "force-dynamic";

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(Buffer.from(b64, "base64"));
};
const b64urlJson = <T>(s: string): T => JSON.parse(Buffer.from(b64urlToBytes(s)).toString("utf8")) as T;

interface EventPayload {
  event: string;
  notificationDetails?: { url?: string; token?: string };
}

export async function POST(req: NextRequest) {
  // Light per-IP rate limit — this endpoint is unauthenticated by design.
  const ip = (req.headers.get("x-forwarded-for") ?? "?").split(",")[0].trim();
  const day = new Date().toISOString().slice(0, 10);
  const n = await kvIncr(`fcwebhook:${ip}:${day}`, 60 * 60 * 24);
  if (n !== null && n > 60) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  let header: { fid?: number; key?: string };
  let payload: EventPayload;
  try {
    const body = (await req.json()) as { header?: string; payload?: string; signature?: string };
    if (!body.header || !body.payload || !body.signature) throw new Error("missing fields");
    if (body.header.length > 2048 || body.payload.length > 4096 || body.signature.length > 2048) throw new Error("too large");

    header = b64urlJson(body.header);
    payload = b64urlJson(body.payload);

    const key = String(header.key ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("bad key");
    const msg = new TextEncoder().encode(`${body.header}.${body.payload}`);
    const ok = ed25519.verify(b64urlToBytes(body.signature), msg, Uint8Array.from(Buffer.from(key.slice(2), "hex")));
    if (!ok) throw new Error("bad signature");
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "invalid" }, { status: 400 });
  }

  const fid = Number(header.fid ?? 0);
  if (!Number.isInteger(fid) || fid <= 0) return NextResponse.json({ error: "bad fid" }, { status: 400 });

  const details = payload.notificationDetails;
  switch (payload.event) {
    case "miniapp_added":
    case "frame_added": // older clients
    case "notifications_enabled":
      if (details?.url && details?.token && /^https:\/\//.test(details.url)) {
        await saveNotifTarget(fid, String(details.url).slice(0, 512), String(details.token).slice(0, 512));
      }
      break;
    case "miniapp_removed":
    case "frame_removed":
    case "notifications_disabled":
      await removeNotifTarget(fid);
      break;
    default:
      break; // unknown events are acked, not errored — clients retry on non-2xx
  }
  return NextResponse.json({ ok: true });
}
