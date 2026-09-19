/**
 * Did a wallet that paid us before come back?
 *
 * This is the one signal the project has been chasing and never surfaced. The
 * catalogue's repeat rate has been measured repeatedly — 1.6 calls per payer in
 * August, 1.78 across the catalogue in September — but always by hand, after the
 * fact, from the discovery index. Nothing told us on the day.
 *
 * It matters more than the amount. A stranger paying once is a crawler, an
 * audit, or curiosity; on 2026-09-19 a single wallet
 * (`0x35ed8c8b…`) bought thirteen services in twenty-seven minutes and turned
 * out to be sampling at least twenty-five different x402 sellers — our largest
 * external day to date and not demand at all. A wallet that comes back on a
 * DIFFERENT day is the first thing that would be.
 *
 * WHY YESTERDAY AND NOT TODAY
 * ---------------------------
 * It reads a complete UTC day. Called from the 03:00 keepalive, "yesterday" is
 * closed and will not change; "today" would be three hours of partial data and
 * would re-alert every morning on the same wallet as the day filled in.
 *
 * OUR OWN WALLETS ARE NOT CUSTOMERS
 * ---------------------------------
 * The buyer wallet settles a dozen keepalive payments every morning, so it
 * would be the most loyal repeat customer this ever found. It is excluded the
 * same way /api/payers excludes it: derived from the key that signs the
 * payments, not from a list someone has to remember to update.
 */

import "server-only";
import { cdpSql } from "./covalent";
import { getConfig, USDC_BASE } from "./config";
import { getBuyerAddress } from "./x402-client";
import { kvSMembers, kvSAdd, kvExpire, kvConfigured } from "./kv";

/** Wallets that have ever paid us, by address. Long TTL: a buyer returning
 *  after three months is a better signal than one returning after three days,
 *  and this set is small — 16 wallets in the fourteen days to 2026-09-16. */
const SEEN_KEY = "payers:seen";
const SEEN_TTL = 60 * 60 * 24 * 365;

export interface RepeatBuyers {
  date: string;
  /** Addresses that paid on `date` and had paid on some earlier day. */
  returning: Array<{ wallet: string; usdc: number; payments: number }>;
  /** Addresses paying for the first time. */
  firstTime: number;
  /** null when the query failed — unknown is not "nobody came back". */
  degraded: boolean;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const nextDay = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return ymd(d);
};

/**
 * Check a complete UTC day for wallets that had paid before.
 *
 * Defaults to yesterday. Records everyone it sees, so the first run teaches it
 * the existing payers and reports nobody — seeding silently rather than
 * announcing sixteen "returning" buyers that simply predate the detector.
 */
export async function checkRepeatBuyers(date?: string): Promise<RepeatBuyers | null> {
  if (!kvConfigured()) return null;
  const cfg = getConfig();
  if (!cfg.payTo) return null;

  const day = date ?? ymd(new Date(Date.now() - 86_400_000));
  const payTo = cfg.payTo.toLowerCase();

  const rows = await cdpSql<{ f?: string; v?: string }>(
    `SELECT lower(toString(parameters['from'])) AS f, toString(parameters['value']) AS v
     FROM base.events
     WHERE address = '${USDC_BASE.toLowerCase()}'
       AND event_signature = 'Transfer(address,address,uint256)'
       AND lower(toString(parameters['to'])) = '${payTo}'
       AND block_timestamp >= '${day} 00:00:00'
       AND block_timestamp < '${nextDay(day)} 00:00:00'
     LIMIT 1000`,
  );
  // A failed query is not an empty day. Saying "nobody came back" because the
  // warehouse was unreachable is the mistake index-gap's degraded guard exists
  // to avoid, and it would be worse here: it also teaches the seen-set nothing,
  // so a real return the next day would read as first-time.
  if (rows === null) return { date: day, returning: [], firstTime: 0, degraded: true };

  const ours = new Set([payTo, ...cfg.ownWallets.map((w) => w.toLowerCase())]);
  const buyer = getBuyerAddress();
  if (buyer) ours.add(buyer.toLowerCase());

  const today = new Map<string, { usdc: number; payments: number }>();
  for (const r of rows) {
    const from = String(r.f ?? "");
    if (!/^0x[0-9a-f]{40}$/.test(from) || ours.has(from)) continue;
    const usd = Number(BigInt(r.v || "0")) / 1e6;
    const prev = today.get(from) ?? { usdc: 0, payments: 0 };
    today.set(from, { usdc: +(prev.usdc + usd).toFixed(4), payments: prev.payments + 1 });
  }

  const seen = new Set((await kvSMembers(SEEN_KEY)) ?? []);
  const firstRun = seen.size === 0;

  const returning: RepeatBuyers["returning"] = [];
  for (const [wallet, agg] of today) {
    if (!firstRun && seen.has(wallet)) returning.push({ wallet, ...agg });
  }

  // kvSAdd takes one member at a time; the day's payer count is single digits,
  // so a loop costs nothing and avoids a variadic the helper does not offer.
  for (const wallet of today.keys()) await kvSAdd(SEEN_KEY, wallet);
  if (today.size) await kvExpire(SEEN_KEY, SEEN_TTL);

  return {
    date: day,
    returning: returning.sort((a, b) => b.usdc - a.usdc),
    firstTime: today.size - returning.length,
    degraded: false,
  };
}

/** What to say when one comes back. Names the wallet, because the operator will
 *  want to look it up, and says plainly why this is worth reading. */
export function repeatBuyerMessage(r: RepeatBuyers): string {
  const lines = r.returning.map(
    (w) => `• ${w.wallet} — ${w.payments} payment${w.payments === 1 ? "" : "s"}, $${w.usdc.toFixed(4)}`,
  );
  return (
    `A wallet that paid us before came back on ${r.date}.\n\n${lines.join("\n")}\n\n` +
    `This is the signal the catalogue has never produced. A stranger paying once is a crawler, an audit or curiosity — ` +
    `2026-09-19's thirteen-service, twenty-seven-minute visit turned out to be sampling at least twenty-five different x402 sellers. ` +
    `A wallet returning on a different day is the first thing that would be demand. Check /api/payers?date=${r.date} for what it bought.`
  );
}
