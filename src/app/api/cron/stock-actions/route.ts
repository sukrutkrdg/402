/**
 * Watch the thirteen tokenized equities for the first corporate action.
 *
 * IT FIRED. 2026-09-14, 18:29 UTC.
 * ---------------------------------
 * GOOGLc's multiplier moved 1.0 → 1.000377118676784179 in block 51310619 — the
 * first corporate action any of Coinbase's tokenized equities has ever had.
 * Verified independently of the alert: reading either side of that block,
 * Uniswap V4's PoolManager (the largest holder) returns balanceOf =
 * 49170507575 at 51310618 and 49170507575 at 51310620, and totalSupply is
 * unchanged at 625695500195, so nothing was minted. The entitlement rose about
 * 0.185 shares. The number every contract, wallet and indexer reads did not.
 *
 * Which settles the thing this was built to be uncertain about. The claim under
 * /stocks and stock-position was previously evidenced on a synthetic B20 we
 * watched move 1.0 → 2.0 — correct, but open to the objection that a test token
 * is not one of these. It is now evidenced on the real asset, on a real event,
 * at a known block.
 *
 * A +0.0377% move is not a split. It is the shape of an accrual — the
 * "yield-generating mechanics" that make these productive assets — which means
 * the next one is a matter of weeks, not years, and the classification work
 * this deliberately deferred now has its first sample to be written against.
 *
 * WHY THIS WAS A WATCHER AND NOT A PRODUCT
 * ----------------------------------------
 * On 2026-09-04 the total number of MultiplierUpdated events across all thirteen
 * of Coinbase's tokenized stocks on Base was ZERO, and every multiplier read
 * exactly 1.0. There has never been a split, a reverse split, or a dividend
 * adjustment on any of them. So there is no corpus to sell and no feed to
 * publish; a "corporate action API" today would serve an empty array, and the
 * first buyer to check would notice.
 *
 * What there IS, is an asymmetry. These are real equities — NVDA, AAPL and MSFT
 * pay quarterly — so the first event is a matter of when. It will land as a
 * single transaction, at a moment nobody has announced, on tokens whose largest
 * holders are all contracts (Uniswap V4's PoolManager leads GOOGLc and METAc),
 * which means nothing downstream is watching by hand. Catching that first one
 * cannot be bought afterwards: the event stays on chain forever, but being the
 * party that published it within minutes is a fact about the past, and nobody
 * can go back and acquire it. The cost of holding that option is one KV read
 * and thirteen eth_calls a day.
 *
 * So this deliberately does very little. It remembers yesterday's multipliers
 * and says so when one of them moves. It does not classify the move as a
 * scheduled ERC-8056 update versus an emergency updateMultiplier(), because no
 * instance of either exists to write that parsing against — that gets built
 * when the first event hands us a sample. Guessing the shape now and being
 * wrong on the one day it matters would waste the whole option.
 *
 * NOT-KNOWN AND UNCHANGED ARE DIFFERENT
 * -------------------------------------
 * A failed RPC read must never be written back as the new baseline. If it were,
 * a network blip would overwrite the last good value and the real change that
 * followed it would compare equal and go unreported — the watcher would fail
 * silently in exactly the situation it exists for. Failed reads are counted,
 * reported, and otherwise left alone.
 *
 * Runs at 05:00 UTC, after index-gap, so a bad morning reports its problems in
 * one pass rather than spread across the hour.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 */

import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/secure";
import { kvGet, kvSet } from "@/lib/kv";
import { alertOwner } from "@/lib/alert-owner";
import { cdpSql } from "@/lib/covalent";
import {
  readMultipliers,
  describeMultiplierChange,
  TOKENIZED_STOCKS,
  readTransferPolicies,
  readSchedules,
  describeScheduledMultiplier,
  scheduleTransition,
  type ScheduledMultiplier,
  type TransferPolicyRead,
} from "@/lib/tokenized-stocks";
import { recognisedEquityIssuance } from "@/lib/b20-safety";

export const dynamic = "force-dynamic";
// Chain reads are batched (multicall) across the 80+ token roster, but the KV
// bookkeeping (baseline GET/SET for the multiplier, policy and schedule watches)
// is still one round trip per token, so the ceiling is raised to give the daily
// run headroom — especially the first run after a deploy, when every key seeds.
export const maxDuration = 300;

const KEY = (sym: string) => `stock:mult:${sym}`;
/** How many 8-decimal B20s existed last time we looked — roster drift detector. */
const ROSTER_KEY = "stock:roster:candidates";
/** Last-seen ERC-8056 schedule fingerprint per stock — `${pending}@${effectiveAt}` or "none". */
const SCHED_KEY = (sym: string) => `stock:sched:${sym}`;

interface Change {
  sym: string;
  token: string;
  from: string;
  to: string;
  effect: string;
  /**
   * "scheduled" when we had read this exact pending value via ERC-8056 before it
   * landed; "emergency" when the move appeared with no schedule on record. This
   * is the classification the watcher deferred until Cobalt made a schedule
   * readable — now decided from evidence (our own prior read), not guessed.
   */
  kind: "scheduled" | "emergency";
  txHash?: string;
  at?: string;
}

/** A schedule fingerprint that survives a KV round-trip and compares by value. */
function schedFingerprint(sm: ScheduledMultiplier): string {
  return sm.status === "scheduled" && sm.pending !== null && sm.effectiveAt !== null
    ? `${sm.pending}@${sm.effectiveAt}`
    : "none";
}

/**
 * Watch the ERC-8056 scheduled-multiplier surface Cobalt added.
 *
 * Two forward-looking facts the plain multiplier watch cannot give, because it
 * only sees a value AFTER it moves:
 *
 *   - newly queued  — a split/accrual is scheduled for a future block and is
 *     still cancelable. Announcing it is the option this whole cron exists to
 *     hold, moved earlier in time: nobody has to wait for the move to land.
 *   - cancelled     — a schedule that was on record is gone AND the multiplier
 *     did not move to it, so it was pulled rather than applied. ("Applied" is
 *     left to the multiplier watch, which reports the actual move.)
 *
 * Same discipline as the rest of this file: an "unknown" read (the selectors
 * revert on a pre-Cobalt / non-Asset token, or the RPC failed) is counted and
 * skipped, never written as a baseline and never alerted on; first sight seeds
 * silently so a deploy does not page thirteen times.
 */
async function scheduleWatch(
  schedules: Map<string, ScheduledMultiplier>,
  multBySym: Map<string, string>,
): Promise<{ newly: string[]; cancelled: string[]; seeded: number; unread: number }> {
  const newly: string[] = [];
  const cancelled: string[] = [];
  let seeded = 0;
  let unread = 0;

  for (const [sym, sm] of schedules) {
    if (sm.status === "unknown") {
      unread++;
      continue; // unknown ≠ "nothing scheduled" — leave the baseline, say nothing
    }
    const now = schedFingerprint(sm);
    const prev = await kvGet(SCHED_KEY(sym));
    if (prev === null) {
      await kvSet(SCHED_KEY(sym), now);
      seeded++;
      continue;
    }

    // scheduleTransition decides applied-vs-cancelled correctly: a schedule that
    // cleared at/after its effective time APPLIED (the multiplier watch reports
    // the move) and must not be mislabelled CANCELLED just because this read beat
    // the move. Only a schedule pulled while still in the future is a cancel.
    const transition = scheduleTransition(prev, now, multBySym.get(sym), Math.floor(Date.now() / 1000));
    if (transition === "scheduled") {
      const desc = describeScheduledMultiplier(multBySym.get(sym) ?? null, sm);
      newly.push(`${sym} ${desc ?? `has a multiplier change queued (${now})`}`);
    } else if (transition === "cancelled") {
      cancelled.push(
        `${sym}: a scheduled multiplier change (${prev}) was pulled before its effective time — CANCELLED, not applied.`,
      );
    }
    // "applied" / "unchanged" → silent: the multiplier watch owns an actual move.
    await kvSet(SCHED_KEY(sym), now);
  }

  return { newly, cancelled, seeded, unread };
}

/**
 * Best-effort evidence for a change we already detected from state.
 *
 * The alert does not depend on this. State comparison is what proves a move
 * happened; this only attaches the transaction so the operator can look at it.
 * Any failure here is swallowed — an evidence lookup must not be able to
 * suppress the alert it was decorating.
 */
async function findEvidence(token: string): Promise<{ txHash?: string; at?: string }> {
  try {
    const rows = await cdpSql<{ transaction_hash?: string; block_timestamp?: string }>(
      `SELECT transaction_hash, block_timestamp FROM base.events ` +
        `WHERE address = '${token.toLowerCase()}' AND event_name = 'MultiplierUpdated' ` +
        `ORDER BY block_timestamp DESC LIMIT 1`,
    );
    const r = rows?.[0];
    return r ? { txHash: r.transaction_hash, at: r.block_timestamp } : {};
  } catch {
    return {};
  }
}

const POLICY_KEY = (sym: string) => `stock:policy:${sym}`;

/**
 * Has the question "who may hold these" changed since yesterday?
 *
 * Measured on 2026-09-14: every tokenized equity carries transfer policy id 5 —
 * a set id, not the unset 0 that the registry treats as always-allow — and the
 * registry authorises an address with no relationship to the issuer: never
 * KYC'd, never a holder, in one case never even used. So the "eligible users in
 * permitted jurisdictions" restriction is not enforced at transfer. It is
 * enforced at issuance and redemption, inside Coinbase's own app.
 *
 * That permissiveness is what makes every builder category Base is asking for
 * possible today — pools, lending markets, gifting contracts, agents holding
 * positions. It is also a policy rather than a property: its admin can change
 * what id 5 authorises at any block, and when they do, nothing about the token
 * address, its ABI or its multiplier changes to announce it. The integrations
 * break silently and all at once.
 *
 * Same discipline as the multiplier watch above: a failed read is never written
 * as a baseline (unknown is not unchanged), and first sight seeds silently
 * rather than alerting thirteen times on first deploy.
 */
async function policyWatch(policies: Map<string, TransferPolicyRead>): Promise<{ changes: string[]; seeded: number; unread: number }> {
  const changes: string[] = [];
  let seeded = 0;
  let unread = 0;

  for (const s of TOKENIZED_STOCKS) {
    const p = policies.get(s.sym) ?? { senderPolicyId: null, receiverPolicyId: null, canaryMaySend: null, canaryMayReceive: null };
    // Any failed leg makes the whole row untrustworthy: a null canary answer
    // beside a real policy id could be read as "not authorised", which is the
    // false alarm this watch exists to avoid.
    if (p.senderPolicyId === null || p.receiverPolicyId === null || p.canaryMaySend === null || p.canaryMayReceive === null) {
      unread++;
      continue;
    }
    const now = `${p.senderPolicyId}/${p.receiverPolicyId}/${p.canaryMaySend ? "send" : "-"}/${p.canaryMayReceive ? "recv" : "-"}`;
    const prev = await kvGet(POLICY_KEY(s.sym));
    if (prev === null) {
      await kvSet(POLICY_KEY(s.sym), now);
      seeded++;
      continue;
    }
    if (prev === now) continue;

    const tightened = (p.canaryMaySend === false || p.canaryMayReceive === false) && /send\/recv$/.test(prev);
    changes.push(
      `${s.sym} (${s.ticker}) transfer policy ${prev} → ${now}` +
        (tightened
          ? " — TIGHTENED: an unrelated address can no longer freely send and/or receive this token."
          : " — the policy id or the canary's authorisation moved; read the board before assuming either direction."),
    );
    await kvSet(POLICY_KEY(s.sym), now);
  }

  return { changes, seeded, unread };
}

/**
 * Has the issuer minted a fourteenth stock?
 *
 * Cheap proxy: every tokenized equity so far has 8 decimals, where 54,206 of
 * the B20s on Base have 18. Counting the 8-decimal population costs one query
 * and catches roster drift without fanning out RPC reads over 88 candidates.
 * It reports CANDIDATES, not stocks — an 8-decimal B20 is a hint, and the
 * operator anchor is what would confirm one.
 */
async function rosterDrift(): Promise<string | null> {
  const rows = await cdpSql<{ tok?: string }>(
    `SELECT toString(parameters['token']) AS tok FROM base.events ` +
      `WHERE event_name = 'B20Created' AND toString(parameters['decimals']) = '8' ` +
      `ORDER BY block_timestamp DESC LIMIT 200`,
  );
  if (!rows) return null; // query failed — say nothing rather than guess
  const known = new Set<string>(TOKENIZED_STOCKS.map((s) => s.token));
  const seen = new Set((await kvGet(ROSTER_KEY))?.split(",").filter(Boolean) ?? []);
  const candidates = rows
    .map((r) => String(r.tok ?? "").toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a) && !known.has(a) && !seen.has(a));

  // Remember every candidate, confirmed or not, so a token is examined once
  // rather than on every run for the rest of its life.
  if (candidates.length) {
    await kvSet(ROSTER_KEY, [...seen, ...candidates].slice(-400).join(","));
  }
  if (candidates.length === 0) return null;

  // The count alone is noise. On 2026-09-10 there were 91 8-decimal B20s and
  // only 13 were equities; the other 78 carry random symbols (UYDW, AQJL,
  // XSTWJ) and are test tokens. A detector that fired on the count would have
  // paged on junk until it was ignored, which is the failure this codebase has
  // already made twice. So each candidate is checked against the thing that
  // actually decides membership — who administers its transfer policy.
  const confirmed: string[] = [];
  for (const addr of candidates.slice(0, 12)) {
    // Returns null for unreadable as well as unrecognised — a candidate we
    // could not check is not reported as a find.
    const hit = await recognisedEquityIssuance(addr);
    if (hit) confirmed.push(`${hit.symbol ?? "?"} (${addr})`);
  }
  if (confirmed.length === 0) return null;

  return (
    `${confirmed.length} new tokenized equity from the same policy operator: ${confirmed.join(", ")}. ` +
    `b20-safety and stock-position already cover it — the operator anchor needs no list — but ` +
    `TOKENIZED_STOCKS in src/lib/tokenized-stocks.ts drives the watcher and /stocks, so add it there.`
  );
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 401 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(provided, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reads = await readMultipliers();
  const unreadable = reads.filter((r) => r.multiplier === null);

  // Every read failed — that is a network verdict, not a market one.
  if (unreadable.length === reads.length) {
    return NextResponse.json(
      {
        ok: false,
        skipped: "degraded",
        reason: `None of the ${reads.length} multipliers could be read; no conclusion drawn and no baseline written.`,
        checkedAt: new Date().toISOString(),
      },
      { status: 503 },
    );
  }

  // Current multiplier per stock, and the ERC-8056 schedule read beside it. The
  // schedule pass runs here, before the change loop, so a detected move can be
  // classified against the schedule we recorded LAST run (read below from KV)
  // while scheduleWatch persists this run's schedule afterwards.
  const multBySym = new Map<string, string>();
  const curBySym = new Map<string, bigint | null>();
  for (const r of reads) {
    if (r.multiplier !== null) {
      multBySym.set(r.sym, r.multiplier);
      curBySym.set(r.sym, BigInt(r.multiplier));
    }
  }

  // Batched ERC-8056 schedule read across the roster (one multicall's worth of
  // newUIMultiplier+effectiveAt per token), instead of a per-token loop that
  // would blow the cron's 60s budget at 80+ tokens.
  const schedules = await readSchedules(TOKENIZED_STOCKS, curBySym);

  const changes: Change[] = [];
  let seeded = 0;

  for (const r of reads) {
    if (r.multiplier === null) continue; // unknown ≠ unchanged; leave the baseline alone
    const prev = await kvGet(KEY(r.sym));
    if (prev === null) {
      // First sight. Record silently — alerting here would fire thirteen times
      // on the first deploy and teach the operator to ignore this cron.
      await kvSet(KEY(r.sym), r.multiplier);
      seeded++;
      continue;
    }
    if (prev === r.multiplier) continue;

    let effect: string;
    try {
      effect = describeMultiplierChange(BigInt(prev), BigInt(r.multiplier));
    } catch {
      effect = "changed (previous value unparseable)";
    }
    // Classify from evidence, not a guess: this move is SCHEDULED iff last run we
    // had recorded a pending ERC-8056 value equal to where it just landed.
    // Otherwise it appeared with no schedule on record — an emergency update.
    const prevSched = await kvGet(SCHED_KEY(r.sym));
    const kind: "scheduled" | "emergency" =
      prevSched && prevSched !== "none" && prevSched.split("@")[0] === r.multiplier ? "scheduled" : "emergency";
    const evidence = await findEvidence(r.token);
    changes.push({ sym: r.sym, token: r.token, from: prev, to: r.multiplier, effect, kind, ...evidence });
    await kvSet(KEY(r.sym), r.multiplier);
  }

  const drift = await rosterDrift().catch(() => null);
  const policies = await readTransferPolicies(TOKENIZED_STOCKS).catch(() => new Map());
  const policy = await policyWatch(policies).catch(() => ({ changes: [], seeded: 0, unread: 0 }));
  const schedule = await scheduleWatch(schedules, multBySym).catch(() => ({ newly: [], cancelled: [], seeded: 0, unread: 0 }));

  if (policy.changes.length > 0) {
    await alertOwner(
      "stock-policy",
      `TRANSFER POLICY CHANGED on Base's tokenized equities.\n\n${policy.changes.join("\n\n")}\n\n` +
        `Until now the registry authorised an address with no relationship to the issuer — never KYC'd, never a holder — so these tokens transferred freely and anything could hold them. ` +
        `If that has tightened, every pool, vault, lending market and agent position built on the permissive behaviour is affected, and nothing about the token address or its ABI changed to signal it. ` +
        `Check /stocks and the board JSON before telling anyone these still move freely.`,
    );
  }

  // Forward-looking: a split/accrual queued for a future block, caught while it
  // is still pending and cancelable — the first time this watcher can speak
  // before a move instead of after it (Cobalt ERC-8056).
  if (schedule.newly.length > 0 || schedule.cancelled.length > 0) {
    await alertOwner(
      "stock-schedule",
      `SCHEDULED multiplier change on Base's tokenized equities (ERC-8056, read before it lands).\n\n` +
        [...schedule.newly.map((s) => `QUEUED — ${s}`), ...schedule.cancelled].join("\n\n") +
        `\n\nA multiplier is a unit change, not a price change: when it takes effect, positions are redenominated and every cached balance for these tokens goes stale at once — and every large holder is a contract. This is the pending read, so there is time to prepare before the effective block.`,
    );
  }

  if (changes.length === 0) {
    return NextResponse.json({
      ok: true,
      watched: reads.length,
      ...(seeded ? { seeded } : {}),
      ...(unreadable.length ? { unreadableCount: unreadable.length, unreadable: unreadable.map((u) => u.sym) } : {}),
      ...(drift ? { rosterDrift: drift } : {}),
      policy: {
        watched: TOKENIZED_STOCKS.length - policy.unread,
        ...(policy.seeded ? { seeded: policy.seeded } : {}),
        ...(policy.unread ? { unread: policy.unread } : {}),
        changes: policy.changes,
      },
      schedule: {
        watched: schedules.size - schedule.unread,
        ...(schedule.seeded ? { seeded: schedule.seeded } : {}),
        ...(schedule.unread ? { unread: schedule.unread } : {}),
        newly: schedule.newly,
        cancelled: schedule.cancelled,
      },
      // Stated plainly so the value is legible even on the quiet days, which so
      // far is all of them.
      note:
        // Not "there has still never been one" — GOOGLc ended that on
        // 2026-09-14. A quiet run means nothing moved SINCE the last one, which
        // is all this comparison can honestly say.
        "No multiplier moved since the last run." +
        (policy.changes.length === 0 ? " Transfer policy unchanged: an unrelated address is still authorised to send and receive." : "") +
        (schedule.newly.length > 0
          ? ` But a change is QUEUED ahead of time (ERC-8056): ${schedule.newly.join("; ")}.`
          : schedule.cancelled.length > 0
            ? ` A previously queued change was cancelled: ${schedule.cancelled.join("; ")}.`
            : ""),
      checkedAt: new Date().toISOString(),
    });
  }

  const lines = changes.map(
    (c) =>
      `${c.sym} multiplier ${c.from} → ${c.to} [${c.kind.toUpperCase()}]: ${c.effect}.` +
      (c.txHash ? ` tx ${c.txHash}${c.at ? ` at ${c.at}` : ""}` : " (no MultiplierUpdated row found yet — the indexer may lag the RPC)"),
  );

  // The classification the watcher deferred is now decided per change: SCHEDULED
  // if we had read its pending ERC-8056 value beforehand, EMERGENCY if it landed
  // with none on record. An emergency move on an equity is the louder finding.
  const anyEmergency = changes.some((c) => c.kind === "emergency");

  const alert = await alertOwner(
    "stock-actions",
    `CORPORATE ACTION on Base's tokenized equities.\n\n${lines.join("\n\n")}\n\n` +
      `A multiplier is a unit change, not a price change: positions are redenominated, not revalued. ` +
      `Anything holding a cached balance for these tokens is now wrong, and every large holder is a contract. ` +
      (anyEmergency
        ? `At least one of these is an EMERGENCY update — it landed with no ERC-8056 schedule read beforehand, so there was no window to prepare.`
        : `Each was SCHEDULED: its pending value was read before it took effect, so this is the anticipated landing of a queued change.`),
  );

  return NextResponse.json({
    ok: false,
    changed: true,
    changes,
    ...(unreadable.length ? { unreadableCount: unreadable.length } : {}),
    ...(drift ? { rosterDrift: drift } : {}),
    policy: { changes: policy.changes, ...(policy.unread ? { unread: policy.unread } : {}) },
    schedule: {
      ...(schedule.unread ? { unread: schedule.unread } : {}),
      newly: schedule.newly,
      cancelled: schedule.cancelled,
    },
    alert,
    checkedAt: new Date().toISOString(),
  });
}
