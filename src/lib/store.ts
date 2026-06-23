/**
 * Recent-payments log.
 *
 * Serverless-safe by design: a module-level in-memory cache is the source of
 * truth within a warm instance, and we *best-effort* persist to a writable temp
 * file. On read-only/ephemeral platforms (e.g. Vercel) the file write may fail
 * or not survive across invocations — that's fine, we never throw, and the
 * attribution dashboard's on-chain lookup is unaffected.
 *
 * For durable, cross-instance history, swap `recordPayment`/`listPayments` for a
 * KV store (Vercel KV / Upstash Redis). The call sites stay identical.
 */

import "server-only";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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

// In-memory cache — primary store within a single (warm) instance.
const memory: PaymentRecord[] = [];

// Writable location: project ./data locally, OS temp dir on serverless.
const onServerless = Boolean(process.env.VERCEL || process.env.AWS_REGION);
const DATA_DIR = onServerless ? path.join(os.tmpdir(), "x402-bazaar") : path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "payments.json");

let hydrated = false;

async function hydrateOnce(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const r of parsed) if (!memory.find((m) => m.id === r.id)) memory.push(r);
    }
  } catch {
    // no file yet — fine
  }
}

export async function recordPayment(rec: PaymentRecord): Promise<void> {
  await hydrateOnce();
  memory.unshift(rec);
  if (memory.length > MAX) memory.length = MAX;
  // best-effort persist; swallow any FS errors (read-only / ephemeral)
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(memory, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

export async function listPayments(limit = 50): Promise<PaymentRecord[]> {
  await hydrateOnce();
  return memory.slice(0, limit);
}
