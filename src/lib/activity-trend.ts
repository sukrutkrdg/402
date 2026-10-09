/**
 * activity-trend — "is this token alive and growing, or quietly dying?"
 * (adoption/activity trajectory — distinct from the price/volume `token-momentum`)
 *
 * token-age tells you when it was born; holder-distribution is a snapshot. Neither
 * tells you the TRAJECTORY. A token can look fine on every static check and still
 * be bleeding users week over week — the thing a trader clocks by watching the
 * chart for days, an agent can't see at all. This reads it straight from on-chain
 * activity: weekly transfer counts and distinct participants over the last 4 weeks.
 *
 * Accelerating adoption, a steady base, a cooling fad, or an abandoned ghost —
 * each has a different shape in the weekly series. Address-filtered, time-bounded
 * CDP SQL (the reliable warehouse path), capped at 28 days so the scan stays
 * inside the warehouse's byte limit on high-volume tokens. A momentum signal, not
 * a price call. Not financial advice.
 */

import "server-only";
import { getAddress } from "viem";
import { cdpSql } from "./covalent";

const TRANSFER = "Transfer(address,address,uint256)";
const validAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test((a ?? "").trim());

interface Row { c1?: string; c2?: string; c3?: string; c4?: string; r1?: string; r2?: string; r3?: string; r4?: string }

export async function activityTrend(params: Record<string, string>) {
  const raw = (params.address || params.token || "").trim();
  if (!validAddr(raw)) throw new Error("Provide a valid 0x… token address");
  const address = getAddress(raw);
  const token = address.toLowerCase();

  // Four FULL 7-day windows anchored to now (c1 = most recent 7 days). Rolling,
  // not calendar buckets — so the current week is never a partial-week false drop.
  // One 28-day scan (cf. wash-trading's 30d cap) keeps it reliable on busy tokens.
  const win = (a: number, b: number) =>
    b === 0
      ? `block_timestamp > now() - INTERVAL ${a} DAY`
      : `block_timestamp <= now() - INTERVAL ${b} DAY AND block_timestamp > now() - INTERVAL ${a} DAY`;
  const rows = await cdpSql<Row>(
    `SELECT countIf(${win(7, 0)}) AS c1, countIf(${win(14, 7)}) AS c2, countIf(${win(21, 14)}) AS c3, countIf(${win(28, 21)}) AS c4, ` +
      `uniqExactIf(toString(parameters['to']), ${win(7, 0)}) AS r1, uniqExactIf(toString(parameters['to']), ${win(14, 7)}) AS r2, ` +
      `uniqExactIf(toString(parameters['to']), ${win(21, 14)}) AS r3, uniqExactIf(toString(parameters['to']), ${win(28, 21)}) AS r4 ` +
      `FROM base.events WHERE address='${token}' AND event_signature='${TRANSFER}' AND block_timestamp > now() - INTERVAL 28 DAY`,
  );
  if (rows === null) throw new Error("Activity data unavailable (warehouse) — not charged, retry shortly");

  const row = rows[0] ?? {};
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const DAY = 86_400_000;
  const dateAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
  // Oldest → newest, each a full 7-day window.
  const weeks = [
    { weekStart: dateAgo(28), transfers: n(row.c4), receivers: n(row.r4) },
    { weekStart: dateAgo(21), transfers: n(row.c3), receivers: n(row.r3) },
    { weekStart: dateAgo(14), transfers: n(row.c2), receivers: n(row.r2) },
    { weekStart: dateAgo(7), transfers: n(row.c1), receivers: n(row.r1) },
  ];

  if (weeks.every((w) => w.transfers === 0)) {
    return { address, windowDays: 28, weeks: [], verdict: "dormant", recommendation: "No transfer activity in the last 28 days — the token is dormant (or not trading). Treat as illiquid/abandoned until it shows a pulse.", note: "Weekly on-chain activity over 28 days (CDP SQL). A momentum signal, not a price call. Not financial advice.", checkedAt: new Date().toISOString() };
  }

  const transfersSeries = weeks.map((w) => w.transfers);
  const peak = Math.max(...transfersSeries);
  const first = weeks[0].transfers;
  const last = weeks[weeks.length - 1].transfers;
  const lastVsPeakPct = peak > 0 ? +((last / peak) * 100).toFixed(0) : 0;
  const trendPct = first > 0 ? +(((last - first) / first) * 100).toFixed(0) : null; // first→last week change
  const totalTransfers = transfersSeries.reduce((s, n) => s + n, 0);
  const latestReceivers = weeks[weeks.length - 1].receivers;

  let verdict: "accelerating" | "steady" | "cooling" | "dying" | "low_activity";
  if (totalTransfers < 20 || peak < 10) verdict = "low_activity";
  else if (lastVsPeakPct < 25) verdict = "dying";
  else if (lastVsPeakPct < 55) verdict = "cooling";
  else if (trendPct != null && trendPct > 30) verdict = "accelerating";
  else verdict = "steady";

  const pct = (n: number | null) => (n == null ? "n/a" : `${n > 0 ? "+" : ""}${n}%`);
  return {
    address,
    windowDays: 28,
    weeks, // oldest → newest, each a full 7-day window: transfers, receivers
    totalTransfers,
    peakWeeklyTransfers: peak,
    latestWeeklyTransfers: last,
    latestWeeklyReceivers: latestReceivers,
    lastVsPeakPct, // latest week as a share of the busiest week
    weekOverWindowTrendPct: trendPct, // first week → latest week
    verdict, // accelerating | steady | cooling | dying | low_activity
    recommendation:
      verdict === "low_activity"
        ? `Very little activity over 28 days (${totalTransfers} transfers) — too thin to read a trend. Treat as illiquid; momentum is not established.`
        : verdict === "dying"
          ? `⚠️ Activity has collapsed — the latest week is only ${lastVsPeakPct}% of the busiest week (${pct(trendPct)} across the window). This token is being abandoned; exiting late into fading liquidity is the risk.`
          : verdict === "cooling"
            ? `Cooling off — the latest week is ${lastVsPeakPct}% of peak (${pct(trendPct)} across the window). The fad is fading; momentum is against you unless it re-ignites.`
            : verdict === "accelerating"
              ? `📈 Accelerating — activity is up ${pct(trendPct)} over the window and the latest week is near its peak (${lastVsPeakPct}%). Growing adoption, not a dead chart.`
              : `Steady — activity is holding around ${lastVsPeakPct}% of peak (${pct(trendPct)} across the window). A stable base rather than a spike or a bleed.`,
    note: "Weekly transfer counts and distinct participants over the last 28 days (CDP SQL) — the adoption trajectory static checks miss. Activity ≠ price, and bursts can be wash/airdrop noise (pair with wash-trading). A momentum signal, not a price call. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
