/**
 * GET /api/events/live — SSE feed of recorded events: paid calls by outside
 * payers (service + price + time) and alert firings (token + type + move + time).
 * See src/lib/live-stream.ts. Each connection closes after 55s; EventSource
 * reconnects by itself and resumes from Last-Event-ID.
 */

import { NextRequest } from "next/server";
import { liveEventStream } from "@/lib/live-stream";
import { kvAnalyticsOff } from "@/lib/kv";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export function GET(req: NextRequest) {
  // Analytics off: there is no feed to serve, and an open EventSource would
  // reconnect every 55s forever. Send a one-shot reply with a 1h backoff so the
  // browser stops polling, costing neither KV nor function time.
  if (kvAnalyticsOff()) {
    return new Response("retry: 3600000\nevent: disabled\ndata: {}\n\n", { headers: SSE_HEADERS });
  }
  const lastEventId = req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("lastEventId");
  return new Response(liveEventStream({ lastEventId, signal: req.signal }), { headers: SSE_HEADERS });
}
