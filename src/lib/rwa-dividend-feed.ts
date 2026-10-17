/**
 * RWA dividend/split feed — what has been applied, what is announced, and what
 * each holder has accrued, across Base's tokenized equities.
 *
 * Rebuilt 2026-10-17 on two measured facts (see stock-corporate-actions.ts):
 * Coinbase announces each dividend on chain days ahead (Announcement, id ":pre")
 * and applies it with an instant multiplier move — not via the ERC-8056
 * schedule — and the old query (an unbounded lower(toString(address)) scan)
 * exceeded the warehouse limit, so history read as degraded on every call.
 *
 * A warehouse read that fails is surfaced as degraded, never as "no actions".
 */

import "server-only";
import { readStockActions } from "./stock-corporate-actions";
import {
  stockRoster,
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
  const roster = await stockRoster();
  const want = (params.symbol || params.ticker || "").trim().toUpperCase().replace(/C$/, "");
  const scope = want ? roster.filter((s) => s.ticker.toUpperCase() === want) : roster;
  if (want && scope.length === 0) throw new Error(`${want} is not a tokenized stock on Base — omit symbol for all`);

  // ---- history + announced: Announcement / MultiplierUpdated events, joined to Coinbase's record ----
  const actions = await readStockActions(scope);
  const historyDegraded = actions === null;
  const history = (actions ?? []).filter((a) => a.status === "applied").slice(0, limit);
  const announced = (actions ?? []).filter((a) => a.status === "announced");

  // ---- upcoming: the queued ERC-8056 schedule (same reader corporate-actions uses) ----
  const mults = await readMultipliers(scope);
  const curBySym = new Map<string, bigint | null>();
  for (const m of mults) curBySym.set(m.sym, m.multiplier !== null ? BigInt(m.multiplier) : null);
  const schedules = await readSchedules(scope, curBySym);
  const upcoming = scope
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

  // What holders have received so far: the live multiplier IS the cumulative accrual.
  const accrued = scope
    .map((s) => ({ s, m: curBySym.get(s.sym) ?? null }))
    .filter((x) => x.m !== null && x.m !== WAD)
    .map(({ s, m }) => ({ symbol: s.sym, ticker: s.ticker, multiplier: ratioOf(m!.toString()), accruedPct: Math.round((Number((m! * 1_000_000_000n) / WAD) / 1e9 - 1) * 1e6) / 1e4 }))
    .sort((x, y) => y.accruedPct - x.accruedPct);

  return {
    asOf: new Date().toISOString(),
    rosterSize: roster.length,
    ...(want ? { symbol: want } : {}),
    history, // applied actions, newest first, with multiplier before/after and the accrual
    historyCount: history.length,
    ...(historyDegraded ? { historyDegraded: true } : {}),
    announced, // announced by the issuer on chain, not yet applied — the real dividend calendar
    announcedCount: announced.length,
    upcoming, // queued ERC-8056 changes (Coinbase has not used this path so far)
    upcomingCount: upcoming.length,
    accrued, // stocks whose multiplier is off 1.0: cumulative share accrual to date
    finding: historyDegraded
      ? "⚠️ The event warehouse could not be read this call — history and announcements are UNKNOWN, not empty. Accrued (read live from chain) is still shown. Re-check."
      : history.length === 0 && announced.length === 0
        ? "No corporate action announced or applied in this scope. This reports what the chain holds and claims nothing beyond it."
        : `${history.length} applied${history[0] ? ` (newest ${history[0].symbol} ${history[0].description}${history[0].accrualPct !== null ? `, +${history[0].accrualPct}% shares` : ""})` : ""}; ${announced.length} announced and pending${announced.length ? `: ${announced.slice(0, 6).map((a) => a.symbol).join(", ")}` : ""}.`,
    note: "Corporate actions on Base's tokenized equities. Coinbase announces a dividend on chain (Announcement, id ':pre') days ahead and applies it with an instant multiplier move; each is joined to Coinbase's own record (status, multiplier before/after). balanceOf never changes — the multiplier does — so a holder's shares = balance × multiplier. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
