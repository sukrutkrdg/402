/**
 * holder-overlap + token-age — two differentiated reads from a token's transfer
 * history that competitors don't serve.
 *
 *   holder-overlap — do two tokens share a recent holder base? The coordinated-
 *     network / farm / sybil signal: a high overlap of wallets active in both,
 *     beyond what two unrelated tokens would share.
 *   token-age      — when was this token born (first transfer), and how old is it?
 *     New ≠ bad, but age is a first-order risk input an agent should have.
 *
 * Both use address-filtered, time-bounded CDP SQL (the reliable warehouse path).
 * Heuristic signals, said as such; an unreadable source is surfaced, not guessed.
 */

import "server-only";
import { cdpSql } from "./covalent";

const validAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test((a ?? "").trim());
const TRANSFER = "Transfer(address,address,uint256)";
const ZERO = "0x0000000000000000000000000000000000000000";

/** Recent distinct recipients of a token (capped), excluding mints & the token itself. */
async function recentHolders(token: string, days: number, cap: number): Promise<Set<string> | null> {
  const rows = await cdpSql<{ a?: string }>(
    `SELECT DISTINCT lower(toString(parameters['to'])) AS a FROM base.events WHERE address='${token}' AND event_signature='${TRANSFER}' AND block_timestamp > now() - INTERVAL ${days} DAY LIMIT ${cap}`,
  );
  if (rows === null) return null;
  const s = new Set<string>();
  for (const r of rows) { const a = r.a ?? ""; if (/^0x[0-9a-f]{40}$/.test(a) && a !== ZERO && a !== token) s.add(a); }
  return s;
}

export async function holderOverlap(params: Record<string, string>) {
  const a = (params.a || params.token1 || params.address || "").trim().toLowerCase();
  const b = (params.b || params.token2 || "").trim().toLowerCase();
  if (!validAddr(a) || !validAddr(b)) throw new Error("Provide two token addresses (a=0x… b=0x…)");
  if (a === b) throw new Error("a and b are the same token");
  const days = Math.min(Math.max(Number(params.days) || 30, 1), 90);

  const [sa, sb] = await Promise.all([recentHolders(a, days, 1000), recentHolders(b, days, 1000)]);
  if (sa === null || sb === null) throw new Error("Transfer data unavailable (warehouse) — not charged, retry shortly");
  if (sa.size === 0 || sb.size === 0) {
    return { tokenA: a, tokenB: b, days, overlap: 0, verdict: "no_activity", note: "One token has no recent recipients in the window — nothing to compare.", checkedAt: new Date().toISOString() };
  }

  const smaller = sa.size <= sb.size ? sa : sb;
  const larger = smaller === sa ? sb : sa;
  const shared: string[] = [];
  for (const x of smaller) if (larger.has(x)) shared.push(x);
  const overlapPct = +((shared.length / smaller.size) * 100).toFixed(1); // share of the smaller set also active in the other

  // Two unrelated mid-size tokens typically share only a few % (common routers /
  // power users). A large overlap is the coordinated-cohort signal.
  const verdict = overlapPct >= 40 ? "strongly_linked" : overlapPct >= 15 ? "overlapping" : "independent";
  return {
    tokenA: a,
    tokenB: b,
    days,
    holdersA: sa.size,
    holdersB: sb.size,
    sharedHolders: shared.length,
    overlapPct, // of the smaller holder set
    sampleShared: shared.slice(0, 8),
    verdict, // independent | overlapping | strongly_linked | no_activity
    recommendation:
      verdict === "strongly_linked"
        ? `${overlapPct}% of the smaller token's recent holders also hold the other — far above the few % unrelated tokens share. A coordinated cohort: same farm, same deployer community, or a sybil set rotating between them.`
        : verdict === "overlapping"
          ? `${overlapPct}% shared holders — more than coincidence; the two have a common audience or some coordinated activity. Worth noting, not alarming.`
          : `Only ${overlapPct}% shared holders — the overlap unrelated tokens show (shared routers/power users). No coordinated-cohort signal.`,
    note: "Shares of recent holders common to two tokens (CDP SQL, capped samples) — a coordinated-network / farm / sybil signal. Recipients, not current balances; routers and power users inflate small overlaps. A signal, not proof. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

export async function tokenAge(params: Record<string, string>) {
  const token = (params.address || params.token || "").trim().toLowerCase();
  if (!validAddr(token)) throw new Error("Provide a token contract address (address=0x…)");

  const rows = await cdpSql<{ b?: string; t?: string }>(
    `SELECT block_number AS b, block_timestamp AS t FROM base.events WHERE address='${token}' AND event_signature='${TRANSFER}' ORDER BY block_timestamp ASC LIMIT 1`,
  );
  if (rows === null) throw new Error("Transfer data unavailable (warehouse) — not charged, retry shortly");
  if (rows.length === 0 || !rows[0].t) {
    return { address: token, verdict: "no_transfers", note: "No transfer events found — the token may be brand new, not yet traded, or not an ERC-20. Treat as unknown, not safe.", checkedAt: new Date().toISOString() };
  }

  const firstAt = rows[0].t;
  const ageDays = Math.floor((Date.now() - Date.parse(firstAt)) / 86_400_000);
  const verdict = ageDays < 1 ? "brand_new" : ageDays < 7 ? "very_new" : ageDays < 30 ? "new" : ageDays < 180 ? "established" : "mature";
  return {
    address: token,
    firstTransferAt: firstAt,
    firstBlock: rows[0].b != null ? Number(rows[0].b) : null,
    ageDays,
    verdict, // brand_new | very_new | new | established | mature
    recommendation:
      ageDays < 7
        ? `⚠️ Only ${ageDays} day(s) old — most rugs happen in the first days. Pair with launch-snipers, sellability and token-risk before any size.`
        : ageDays < 30
          ? `${ageDays} days old — past the first-day danger but still young; size with caution.`
          : `${ageDays} days old — an established age (not a safety guarantee; age is one input).`,
    note: "Age from a token's earliest transfer on Base (CDP SQL). New ≠ bad, but most rugs are young; age is a first-order risk input, not a verdict on its own. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
