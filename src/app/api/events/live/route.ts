/**
 * GET /api/events/live — SSE feed of recorded events: paid calls by outside
 * payers (service + price + time) and alert firings (token + type + move + time).
 * See src/lib/live-stream.ts. Each connection closes after 55s; EventSource
 * reconnects by itself and resumes from Last-Event-ID.
 */

import { NextRequest } from "next/server";
import { liveEventStream } from "@/lib/live-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export function GET(req: NextRequest) {
  const lastEventId = req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("lastEventId");
  return new Response(liveEventStream({ lastEventId, signal: req.signal }), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
