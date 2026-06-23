/**
 * Tiny append-only payment log persisted to ./data/payments.json.
 *
 * This is intentionally a flat file (not a DB) so the demo has zero
 * infrastructure. It records every successful buy so the dashboard can show
 * recent settlements and their onchain Builder Code attribution.
 */

import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface PaymentRecord {
  id: string;
  serviceId: string;
  serviceName: string;
  price: string;
  txHash: string;
  network: string;
  payer?: string;
  /** Builder codes as sent / echoed at request time. */
  appCode: string;
  clientCode: string;
  createdAt: string;
}

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "payments.json");
const MAX = 200;

async function readAll(): Promise<PaymentRecord[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function recordPayment(rec: PaymentRecord): Promise<void> {
  const all = await readAll();
  all.unshift(rec);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(all.slice(0, MAX), null, 2), "utf8");
}

export async function listPayments(limit = 50): Promise<PaymentRecord[]> {
  const all = await readAll();
  return all.slice(0, limit);
}
