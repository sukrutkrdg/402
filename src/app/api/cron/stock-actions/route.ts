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
import { readMultipliers, describeMultiplierChange, TOKENIZED_STOCKS, readTransferPolicy } from "@/lib/tokenized-stocks";
import { recognisedEquityIssuance } from "@/lib/b20-safety";

export const dynamic = "force-dynamic";
// Thirteen sequential eth_calls plus one optional SQL lookup.
export const maxDuration = 60;

const KEY = (sym: string) => `stock:mult:${sym}`;
/** How many 8-decimal B20s existed last time we looked — roster drift detector. */
const ROSTER_KEY = "stock:roster:candidates";

interface Change {
  sym: string;
  token: string;
  from: string;
  to: string;
  effect: string;
  txHash?: string;
  at?: string;
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
async function policyWatch(): Promise<{ changes: string[]; seeded: number; unread: number }> {
  const changes: string[] = [];
  let seeded = 0;
  let unread = 0;

  for (const s of TOKENIZED_STOCKS) {
    const p = await readTransferPolicy(s.token);
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
    const evidence = await findEvidence(r.token);
    changes.push({ sym: r.sym, token: r.token, from: prev, to: r.multiplier, effect, ...evidence });
    await kvSet(KEY(r.sym), r.multiplier);
  }

  const drift = await rosterDrift().catch(() => null);
  const policy = await policyWatch().catch(() => ({ changes: [], seeded: 0, unread: 0 }));

  if (policy.changes.length > 0) {
    await alertOwner(
      "stock-policy",
      `TRANSFER POLICY CHANGED on Base's tokenized equities.\n\n${policy.changes.join("\n\n")}\n\n` +
        `Until now the registry authorised an address with no relationship to the issuer — never KYC'd, never a holder — so these tokens transferred freely and anything could hold them. ` +
        `If that has tightened, every pool, vault, lending market and agent position built on the permissive behaviour is affected, and nothing about the token address or its ABI changed to signal it. ` +
        `Check /stocks and the board JSON before telling anyone these still move freely.`,
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
      // Stated plainly so the value is legible even on the quiet days, which so
      // far is all of them.
      note:
        // Not "there has still never been one" — GOOGLc ended that on
        // 2026-09-14. A quiet run means nothing moved SINCE the last one, which
        // is all this comparison can honestly say.
        "No multiplier moved since the last run." +
        (policy.changes.length === 0 ? " Transfer policy unchanged: an unrelated address is still authorised to send and receive." : ""),
      checkedAt: new Date().toISOString(),
    });
  }

  const lines = changes.map(
    (c) =>
      `${c.sym} multiplier ${c.from} → ${c.to}: ${c.effect}.` +
      (c.txHash ? ` tx ${c.txHash}${c.at ? ` at ${c.at}` : ""}` : " (no MultiplierUpdated row found yet — the indexer may lag the RPC)"),
  );

  const alert = await alertOwner(
    "stock-actions",
    `FIRST CORPORATE ACTION on Base's tokenized equities.\n\n${lines.join("\n\n")}\n\n` +
      `A multiplier is a unit change, not a price change: positions are redenominated, not revalued. ` +
      `Anything holding a cached balance for these tokens is now wrong, and every large holder is a contract. ` +
      `This is also the sample that was missing — the scheduled-vs-emergency classification can be written against it now.`,
  );

  return NextResponse.json({
    ok: false,
    changed: true,
    changes,
    ...(unreadable.length ? { unreadableCount: unreadable.length } : {}),
    ...(drift ? { rosterDrift: drift } : {}),
    policy: { changes: policy.changes, ...(policy.unread ? { unread: policy.unread } : {}) },
    alert,
    checkedAt: new Date().toISOString(),
  });
}
