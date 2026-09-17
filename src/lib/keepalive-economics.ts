/**
 * What the keepalive actually costs, and what outsiders actually pay.
 *
 * The keepalive settles a payment against endpoints nobody has bought lately so
 * they stay inside the Bazaar's rolling window.
 *
 * THAT USDC IS NOT A COST
 * -----------------------
 * It was described as one here, and on the panel, and that was wrong. Checked on
 * chain against a real settlement (the $1 credit pack, tx 0xddfb88cd…): the
 * transaction contains exactly ONE USDC Transfer log, buyer → seller, for the
 * full amount. The facilitator takes no cut, and the gas was paid by
 * 0x772003a2… — the facilitator's own submitter, not us.
 *
 * Both wallets are ours. So the money goes in a circle and the net cash movement
 * is zero. Counting it as spend made the conveyor look like a drain and framed a
 * question ("is being findable worth $0.18/day?") whose premise did not hold.
 *
 * What the keepalive DOES cost is the upstream each call consumes: Anthropic
 * tokens on the 11 AI services, Exa/Tavily quota on the 5 search-backed ones.
 * The other 145 read chain data and free APIs. At one refresh per service per
 * three weeks that is well under one AI call a day.
 *
 * So the number that matters is external revenue on its own, and this reports it
 * without the false denominator.
 *
 * WHAT THE WINDOW IS FOR
 * ----------------------
 * External revenue was about $0.45 over the fourteen days to 2026-09-16, across
 * 16 wallets, with 13 of 161 services bought at all. Read alone that invites
 * "there is no demand" — and the fortnight cannot support it, because until
 * 2026-09-14 the catalogue published unusable examples for 107 of 159 required
 * parameters, eleven services were absent from discovery while reading as fresh,
 * and the CDN refused library clients outright. An agent that found us often
 * could not construct a call that worked.
 *
 * So that figure measures a broken funnel, not a market. This keeps the count
 * from a stated start date so the next reading is taken with the funnel whole,
 * and refuses to draw a conclusion before two weeks of it exist.
 *
 * NET, NOT GROSS
 * --------------
 * Keepalive settlements arrive in the seller wallet and look exactly like
 * income, so they are always subtracted. Costing nothing does not make them
 * sales — the same error that had our own buyer listed as a customer and a
 * bridge delivery booked as revenue.
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
  /** USDC the keepalive moved between our own wallets. Circulated, not spent. */
  circulatedUsd: number;
  settlements: number;
  circulatedUsdPerDay: number;
  /** Settled revenue less our own keepalive — what outsiders actually paid. */
  externalUsd: number;
  externalUsdPerDay: number;
  /**
   * External revenue against circulated USDC — a scale reference, NOT a return
   * on spend. The circulated amount costs us nothing (see the header), so a
   * ratio below 1 is not a loss; it only says how small outside demand is next
   * to the traffic we generate keeping listings alive.
   */
  externalVsCirculated: number | null;
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
  const circulatedUsd = +(spentCents / 100).toFixed(2);

  const startedAt = since ? new Date(since) : null;
  // At least one, so a first-day reading is a daily rate rather than a division
  // by zero dressed up as infinity.
  const days = startedAt ? Math.max(1, (Date.now() - startedAt.getTime()) / 86_400_000) : 0;

  // Still subtracted: our own settlements land in the seller wallet and would
  // otherwise read as demand. That they cost nothing does not make them sales.
  const externalUsd = +Math.max(0, settledUsd - circulatedUsd).toFixed(2);
  const perDay = (n: number) => (days > 0 ? +(n / days).toFixed(3) : 0);
  const externalVsCirculated = circulatedUsd > 0 ? +(externalUsd / circulatedUsd).toFixed(2) : null;

  return {
    since: since ?? null,
    days: +days.toFixed(1),
    circulatedUsd,
    settlements,
    circulatedUsdPerDay: perDay(circulatedUsd),
    externalUsd,
    externalUsdPerDay: perDay(externalUsd),
    externalVsCirculated,
    verdict:
      days < 14
        ? `Too early to read: ${days.toFixed(0)} day(s) of data. The catalogue only began publishing runnable examples on 2026-09-14, so anything shorter than a couple of weeks is measuring the fix, not the market.`
        : `Outside demand is $${externalUsd.toFixed(2)} over ${days.toFixed(0)} days. The keepalive USDC alongside it is circular — our own wallets, no facilitator cut, gas paid by the facilitator — so it is not a cost to weigh this against. The real cost of staying indexed is the upstream each refresh consumes: Anthropic on 11 services, Exa/Tavily on 5, nothing on the other 145.`,
  };
}
