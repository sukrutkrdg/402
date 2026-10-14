/**
 * Server-Sent Events stream of recorded events (src/lib/live-events.ts).
 *
 * Bounded on purpose: every stream closes itself after `durationMs` (55s in
 * production) and tells the client to reconnect; the browser's EventSource does
 * that on its own and sends Last-Event-ID, so nothing is missed or repeated. A
 * never-closing stream is a function that bills forever.
 *
 * While open it polls KV every `pollMs` (one shared LRANGE per instance per
 * window — see readFeedShared) and sends a heartbeat comment every
 * `heartbeatMs` so proxies keep the connection. It only ever forwards events
 * that are in the recorded list; when nothing happened, nothing is sent.
 */

import "server-only";
import { eventTimeMs, readFeedShared, type LiveEvent } from "./live-events";

export const LIVE_STREAM_MS = 55_000;
export const LIVE_POLL_MS = 5_000;
export const LIVE_HEARTBEAT_MS = 15_000;
export const LIVE_RETRY_MS = 3_000;
export const LIVE_BACKLOG = 20;

export interface LiveStreamOptions {
  lastEventId?: string | null;
  signal?: AbortSignal;
  durationMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  read?: () => Promise<LiveEvent[]>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

export function liveEventStream(opts: LiveStreamOptions = {}): ReadableStream<Uint8Array> {
  const durationMs = Math.min(opts.durationMs ?? LIVE_STREAM_MS, LIVE_STREAM_MS);
  const pollMs = opts.pollMs ?? LIVE_POLL_MS;
  const heartbeatMs = opts.heartbeatMs ?? LIVE_HEARTBEAT_MS;
  const read = opts.read ?? (() => readFeedShared(Math.min(4000, pollMs - 1)));
  const enc = new TextEncoder();

  // Cursor: the last event the client has. Events at or before it are never resent.
  const lastId = (opts.lastEventId ?? "").trim().slice(0, 32);
  let cursorMs = lastId ? eventTimeMs(lastId) : 0;
  const sent = new Set<string>(lastId ? [lastId] : []);
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const tick = async (first: boolean) => {
        let events: LiveEvent[];
        try {
          events = await read();
        } catch {
          events = [];
        }
        // Newest-first in storage; send oldest-first. Without a cursor, the first
        // tick replays the most recent recorded events (each with its real time).
        const fresh = events
          .filter((e) => !sent.has(e.id) && eventTimeMs(e.id) >= cursorMs)
          .slice(0, first && !lastId ? LIVE_BACKLOG : undefined)
          .reverse();
        if (first) {
          send(`event: status\ndata: ${JSON.stringify({ recordedEvents: events.length, closesInMs: durationMs })}\n\n`);
        }
        for (const e of fresh) {
          sent.add(e.id);
          cursorMs = Math.max(cursorMs, eventTimeMs(e.id));
          send(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
        }
      };

      const run = async () => {
        const deadline = Date.now() + durationMs;
        send(`retry: ${LIVE_RETRY_MS}\n\n`);
        await tick(true);
        let lastBeat = Date.now();
        while (!closed && !opts.signal?.aborted) {
          const left = deadline - Date.now();
          if (left <= 0) break;
          await sleep(Math.min(pollMs, left), opts.signal);
          if (closed || opts.signal?.aborted || Date.now() >= deadline) break;
          await tick(false);
          if (Date.now() - lastBeat >= heartbeatMs) {
            send(": heartbeat\n\n");
            lastBeat = Date.now();
          }
        }
        send(`event: bye\ndata: ${JSON.stringify({ reconnectInMs: LIVE_RETRY_MS })}\n\n`);
        close();
      };
      void run().catch(close);
    },
    cancel() {
      closed = true;
    },
  });
}
