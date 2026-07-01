/**
 * Recent-payments log.
 *
 * Durable when KV is configured (Upstash Redis / Vercel KV): payments persist
 * across serverless instances and deploys. An in-memory list is kept as a fast
 * warm-instance cache and as a fallback when KV isn't configured. Nothing here
 * ever throws — the attribution dashboard's on-chain lookup is the ultimate
 * source of truth, so a missed write is cosmetic, never data loss.
 */

import "server-only";
import { kvConfigured, kvLPush, kvLRange } from "./kv";

export interface PaymentRecord {
  id: string;
  serviceId: string;
  serviceName: string;
  price: string;
  txHash: string;
  network: string;
  payer?: string;
  appCode: string;
  clientCode: string;
  createdAt: string;
}

const MAX = 200;
const KEY = "payments:recent";

// In-memory cache — fast path within a single warm instance + fallback when
// KV isn't configured.
const memory: PaymentRecord[] = [];

export async function recordPayment(rec: PaymentRecord): Promise<void> {
  // warm-instance cache
  memory.unshift(rec);
  if (memory.length > MAX) memory.length = MAX;
  // durable, cross-instance persistence (best-effort; never throws)
  try {
    await kvLPush(KEY, JSON.stringify(rec), MAX);
  } catch {
    /* ignore — memory cache still holds it */
  }
}

export async function listPayments(limit = 50): Promise<PaymentRecord[]> {
  // Prefer KV (durable, cross-instance) when configured.
  if (kvConfigured()) {
    try {
      const raw = await kvLRange(KEY, 0, limit - 1);
      const parsed = raw
        .map((s) => {
          try {
            return JSON.parse(s) as PaymentRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is PaymentRecord => r !== null);
      if (parsed.length > 0) return parsed;
    } catch {
      /* fall through to memory */
    }
  }
  return memory.slice(0, limit);
}
