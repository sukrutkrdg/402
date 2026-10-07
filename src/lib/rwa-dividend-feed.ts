/**
 * RWA dividend/split feed — the HISTORY of corporate actions on Base's tokenized
 * equities, plus what is scheduled next.
 *
 * corporate-actions answers "what is queued" (the forward-looking ERC-8056
 * schedule). This is the other half: the record of multiplier moves that have
 * ALREADY happened across the roster — the splits, reverse splits and dividend
 * accruals an accountant reconstructing cost basis, or a vault repricing NAV,
 * needs the timeline of. Read from MultiplierUpdated events on chain, newest
 * first, mapped back to the stock, with the queued changes appended so one call
 * gives past + pending.
 *
 * The first such event anywhere was GOOGLc on 2026-09-14 (1.0 →
 * 1.000377118676784179), so this feed was empty by fact, not by bug, until then —
 * it reports what the chain returns and makes no claim beyond it. A warehouse
 * read that fails is surfaced as degraded, never as "no actions".
 */

import "server-only";
import { cdpSql } from "./covalent";
import {
  TOKENIZED_STOCKS,
  WAD,
  readMultipliers,
  readSchedules,
  describeScheduledMultiplier,
} from "./tokenized-stocks";

const ratioOf = (wad: string) => {
  try { return Number((BigInt(wad) * 1_000_000n) / WAD) / 1_000_000; } catch { return null; }
};

export async function rwaDividendFeed(params: Record<string, string>) {
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
  const byAddr = new Map(TOKENIZED_STOCKS.map((s) => [s.token.toLowerCase(), s]));
  const inList = TOKENIZED_STOCKS.map((s) => `'${s.token.toLowerCase()}'`).join(",");

  // ---- history: MultiplierUpdated events across the roster, newest first ----
  const rows = await cdpSql<{ addr?: string; tx?: string; t?: string; blk?: string }>(
    `SELECT lower(toString(address)) AS addr, transaction_hash AS tx, block_timestamp AS t, block_number AS blk
     FROM base.events
     WHERE event_name = 'MultiplierUpdated' AND lower(toString(address)) IN (${inList})
     ORDER BY block_timestamp DESC
     LIMIT ${limit}`,
  );
  const historyDegraded = rows === null;
  const history = (rows ?? [])
    .map((r) => {
      const s = byAddr.get(String(r.addr ?? ""));
      if (!s) return null;
      return { symbol: s.sym, ticker: s.ticker, token: s.token, txHash: r.tx ?? null, at: r.t ?? null, block: r.blk ?? null };
    })
    .filter(Boolean);

  // ---- upcoming: the queued ERC-8056 schedule (same reader corporate-actions uses) ----
  const mults = await readMultipliers();
  const curBySym = new Map<string, bigint | null>();
  for (const m of mults) curBySym.set(m.sym, m.multiplier !== null ? BigInt(m.multiplier) : null);
  const schedules = await readSchedules(TOKENIZED_STOCKS, curBySym);
  const upcoming = TOKENIZED_STOCKS
    .map((s) => ({ s, sched: schedules.get(s.sym) }))
    .filter((x) => x.sched?.status === "scheduled")
    .map(({ s, sched }) => ({
      symbol: s.sym,
      ticker: s.ticker,
      token: s.token,
      pendingRatio: sched!.pending ? ratioOf(sched!.pending) : null,
      effectiveAtIso: sched!.effectiveAt ? new Date(sched!.effectiveAt * 1000).toISOString() : null,
      summary: describeScheduledMultiplier(curBySym.get(s.sym)?.toString() ?? null, sched!),
    }))
    .sort((a, b) => (a.effectiveAtIso ?? "").localeCompare(b.effectiveAtIso ?? ""));

  return {
    asOf: new Date().toISOString(),
    rosterSize: TOKENIZED_STOCKS.length,
    history, // past MultiplierUpdated events, newest first
    historyCount: history.length,
    ...(historyDegraded ? { historyDegraded: true } : {}),
    upcoming, // queued ERC-8056 changes
    upcomingCount: upcoming.length,
    finding:
      historyDegraded
        ? "⚠️ The event warehouse could not be read this call — the history is UNKNOWN, not empty. Upcoming (read live from chain) is still shown. Re-check the history."
        : history.length === 0
          ? "No corporate action has been recorded on any tokenized equity in this window. The first anywhere was GOOGLc on 2026-09-14; this reports what the chain holds and claims nothing beyond it."
          : `${history.length} past corporate action(s) on chain, newest ${history[0]!.symbol}. ${upcoming.length} queued ahead (ERC-8056).`,
    note: "The timeline of corporate actions on Base's tokenized equities: past multiplier moves from MultiplierUpdated events (the record for cost-basis / NAV reconstruction) plus the queued ERC-8056 schedule. The historical companion to corporate-actions (which is upcoming-only). A failed warehouse read reads as degraded, never 'no actions'. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
