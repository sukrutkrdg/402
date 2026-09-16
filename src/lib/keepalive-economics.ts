/**
 * Is staying in the discovery index worth what it costs?
 *
 * The keepalive settles a payment against endpoints nobody has bought lately, so
 * they stay inside the Bazaar's rolling window. That money goes from our buyer
 * wallet to our seller wallet — it is a real settlement on chain, and it is our
 * own money going in a circle. Measured over the fourteen days to 2026-09-16 it
 * ran about $0.18 a day while external customers paid roughly $0.03 a day, and
 * 13 of 161 services saw an external purchase at all.
 *
 * WHY THIS IS A LEDGER AND NOT A CUT
 * ----------------------------------
 * The obvious reading of those numbers is to stop paying for the 148. It is the
 * wrong move right now, and the reason is a measurement problem rather than a
 * judgement call: until 2026-09-14 the catalogue published unusable examples for
 * 107 of 159 required parameters, eleven services were absent from discovery
 * while reading as fresh, and the CDN refused library clients outright. An agent
 * that found us frequently could not construct a call that worked.
 *
 * So the fourteen-day figure measures a broken funnel, not a market. Cutting
 * discovery spend on that evidence would remove the discovery the newly-working
 * catalogue depends on, and would do it in the same week the funnel was fixed —
 * guaranteeing the next fourteen days look identical and "proving" the decision
 * right.
 *
 * What this does instead is make the decision arrive on its own. It records what
 * we spend to stay findable and what outsiders pay, from a stated start date, so
 * that in a few weeks the ratio is a fact rather than an argument. If external
 * revenue stays flat with a working funnel, the case for cutting is made and the
 * numbers will be here to make it.
 *
 * NET, NOT GROSS
 * --------------
 * Keepalive spend arrives in the seller wallet as revenue. Counting it would
 * make the conveyor look like demand — the same error that had our own buyer
 * listed as a customer and a bridge delivery booked as a sale. External revenue
 * here is always settled revenue MINUS what we paid ourselves.
 */

import "server-only";
import { kvGet, kvSet, kvIncrBy, kvConfigured } from "./kv";

const KEY = {
  /** Cents the keepalive has settled against our own endpoints. */
  spent: "keepalive:spent:cents",
  /** How many such settlements. */
  calls: "keepalive:calls",
  /** When counting began — the baseline date, so a ratio has a window. */
  since: "keepalive:since",
} as const;

/**
 * Record one keepalive settlement.
 *
 * Called only after a successful paid response, so a failed call — which settles
 * nothing — never enters the books. Failure is swallowed: this is accounting,
 * and it must not be able to break the run it is describing.
 */
export async function recordKeepaliveSpend(cents: number): Promise<void> {
  if (!kvConfigured() || !Number.isFinite(cents) || cents <= 0) return;
  try {
    // Set once, never overwritten: the window has to start somewhere fixed, or
    // every reading is against a different denominator.
    if (!(await kvGet(KEY.since))) await kvSet(KEY.since, new Date().toISOString());
    await Promise.all([kvIncrBy(KEY.spent, Math.round(cents)), kvIncrBy(KEY.calls, 1)]);
  } catch {
    /* the settlement is the point; this is only the books */
  }
}

export interface KeepaliveEconomics {
  /** ISO date counting started. null before the first settlement is recorded. */
  since: string | null;
  days: number;
  spentUsd: number;
  settlements: number;
  spentUsdPerDay: number;
  /** Settled revenue less our own keepalive — what outsiders actually paid. */
  externalUsd: number;
  externalUsdPerDay: number;
  /**
   * External revenue per dollar of discovery spend. Below 1 means the conveyor
   * costs more than the demand it is there to make findable. It is expected to
   * be below 1 early; the question is which way it moves.
   */
  returnRatio: number | null;
  verdict: string;
}

/**
 * Read the ledger. `settledUsd` comes from the caller because only the revenue
 * scan knows it, and it must already exclude non-settlement arrivals — bridges,
 * refunds and transfers between our own wallets are not revenue.
 */
export async function keepaliveEconomics(settledUsd: number): Promise<KeepaliveEconomics | null> {
  if (!kvConfigured()) return null;
  const [since, spentRaw, callsRaw] = await Promise.all([
    kvGet(KEY.since),
    kvGet(KEY.spent),
    kvGet(KEY.calls),
  ]);
  const spentCents = Number(spentRaw ?? 0) || 0;
  const settlements = Number(callsRaw ?? 0) || 0;
  const spentUsd = +(spentCents / 100).toFixed(2);

  const startedAt = since ? new Date(since) : null;
  // At least one, so a first-day reading is a daily rate rather than a division
  // by zero dressed up as infinity.
  const days = startedAt ? Math.max(1, (Date.now() - startedAt.getTime()) / 86_400_000) : 0;

  const externalUsd = +Math.max(0, settledUsd - spentUsd).toFixed(2);
  const perDay = (n: number) => (days > 0 ? +(n / days).toFixed(3) : 0);
  const returnRatio = spentUsd > 0 ? +(externalUsd / spentUsd).toFixed(2) : null;

  return {
    since: since ?? null,
    days: +days.toFixed(1),
    spentUsd,
    settlements,
    spentUsdPerDay: perDay(spentUsd),
    externalUsd,
    externalUsdPerDay: perDay(externalUsd),
    returnRatio,
    verdict:
      days < 14
        ? `Too early to read: ${days.toFixed(0)} day(s) of data. The catalogue only began publishing runnable examples on 2026-09-14, so anything shorter than a couple of weeks is measuring the fix, not the market.`
        : returnRatio === null
          ? "No discovery spend recorded yet."
          : returnRatio >= 1
            ? `Outside demand exceeds what we pay to be findable (${returnRatio}× ). The conveyor is paying for itself.`
            : `Outside demand is ${returnRatio}× what we pay to be findable. With a working funnel and a window this long, the case for narrowing which services we keep indexed is now an evidence question, not a guess — the services with no external purchase in the window are the ones to look at first.`,
  };
}
