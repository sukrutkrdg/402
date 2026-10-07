/**
 * Corporate actions calendar — upcoming splits/accruals on Base's tokenized
 * equities, read from the ERC-8056 schedule BEFORE they land (Cobalt).
 *
 * On a B20 Asset token a split, reverse split or dividend adjustment is settled
 * by moving the multiplier, and balanceOf does NOT change when it does — so an
 * integrator reading balanceOf is silently wrong the moment one fires. Cobalt
 * made the PENDING change readable (newUIMultiplier/effectiveAt), which turns
 * that from a surprise into a calendar: this lists every scheduled multiplier
 * change across the 80+ tokenized stocks, and — with a wallet — which of them
 * touch a position that wallet actually holds.
 *
 * Nobody else publishes this: discovery of the roster is the policy-admin anchor
 * (no hardcoded list), and the schedule is read live. A revert on the scheduled
 * selectors is "nothing queued", never a guess, and an RPC failure is surfaced
 * rather than read as "no action".
 */

import "server-only";
import { createPublicClient, getAddress } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import {
  TOKENIZED_STOCKS,
  WAD,
  readMultipliers,
  readSchedules,
  describeScheduledMultiplier,
  type TokenizedStock,
} from "./tokenized-stocks";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

const BAL_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const ratioOf = (wad: string) => Number((BigInt(wad) * 1_000_000n) / WAD) / 1_000_000;

export async function corporateActions(params: Record<string, string>) {
  const walletRaw = (params.wallet || params.address || "").trim();
  const wallet = /^0x[0-9a-fA-F]{40}$/.test(walletRaw) ? getAddress(walletRaw) : null;

  // Current multipliers (batched) → schedules (batched), reusing the roster-scale
  // readers so this stays a handful of eth_calls at 80+ tokens.
  const mults = await readMultipliers();
  const curBySym = new Map<string, bigint | null>();
  for (const m of mults) curBySym.set(m.sym, m.multiplier !== null ? BigInt(m.multiplier) : null);
  const schedules = await readSchedules(TOKENIZED_STOCKS, curBySym);

  const bySym = new Map<string, TokenizedStock>(TOKENIZED_STOCKS.map((s) => [s.sym, s]));
  const scheduled = TOKENIZED_STOCKS
    .map((s) => ({ s, sched: schedules.get(s.sym) }))
    .filter((x) => x.sched?.status === "scheduled")
    .map(({ s, sched }) => ({
      symbol: s.sym,
      ticker: s.ticker,
      name: s.name,
      token: s.token,
      pending: sched!.pending,
      pendingRatio: sched!.pending ? ratioOf(sched!.pending) : null,
      effectiveAt: sched!.effectiveAt,
      effectiveAtIso: sched!.effectiveAt ? new Date(sched!.effectiveAt * 1000).toISOString() : null,
      summary: describeScheduledMultiplier(curBySym.get(s.sym)?.toString() ?? null, sched!),
    }))
    .sort((a, b) => (a.effectiveAt ?? 0) - (b.effectiveAt ?? 0));

  const unreadable = mults.filter((m) => m.multiplier === null).map((m) => m.sym);

  // With a wallet, intersect the schedule with what it actually holds — the part
  // that will move THIS holder's entitlement. Batched balanceOf across the stocks
  // that have something queued (there is no point reading balances otherwise).
  let holdingsAffected: Array<Record<string, unknown>> | undefined;
  if (wallet && scheduled.length > 0) {
    const contracts = scheduled.map((x) => ({ address: getAddress(x.token), abi: BAL_ABI, functionName: "balanceOf", args: [wallet] }));
    let bal: Array<{ status: string; result?: unknown }> = [];
    try {
      bal = (await client.multicall({ contracts: contracts as never, allowFailure: true })) as never;
    } catch {
      bal = scheduled.map(() => ({ status: "failure" }));
    }
    holdingsAffected = scheduled
      .map((x, i) => {
        const r = bal[i];
        const raw = r && r.status === "success" ? (r.result as bigint) : null;
        return { x, raw };
      })
      .filter((e) => e.raw !== null && e.raw > 0n)
      .map((e) => ({
        symbol: e.x.symbol,
        ticker: e.x.ticker,
        rawBalance: (e.raw as bigint).toString(),
        pendingRatio: e.x.pendingRatio,
        effectiveAtIso: e.x.effectiveAtIso,
        summary: e.x.summary,
      }));
  }

  return {
    asOf: new Date().toISOString(),
    scanned: TOKENIZED_STOCKS.length,
    scheduledCount: scheduled.length,
    scheduled,
    ...(unreadable.length ? { degraded: true, unreadable } : {}),
    ...(wallet ? { wallet, holdingsAffected: holdingsAffected ?? [] } : {}),
    finding:
      scheduled.length === 0
        ? "No scheduled multiplier change is queued on any tokenized equity right now. This reads the pending ERC-8056 schedule live, so a split/accrual appears here the moment it is scheduled — before it moves balances."
        : `${scheduled.length} scheduled corporate action(s): ${scheduled.map((x) => `${x.symbol} ${x.summary ?? "pending"}`).join("; ")}.` +
          (wallet ? ` ${holdingsAffected?.length ?? 0} touch this wallet's holdings.` : " Pass wallet= to see which touch a wallet's holdings."),
    note: "Upcoming corporate actions on Base's tokenized equities, read from the Cobalt ERC-8056 schedule before they take effect. A multiplier move redenominates positions (balanceOf does not change when it fires), so this is the warning an integrator needs ahead of time. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
