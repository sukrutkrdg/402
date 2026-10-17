/**
 * Corporate actions on Base's tokenized equities, as Coinbase actually runs them.
 *
 * Measured 2026-10-17, which corrects what this codebase assumed:
 *
 *   - Coinbase does NOT use the ERC-8056 schedule (newUIMultiplier/effectiveAt)
 *     for dividends. It emits `Announcement(…, "Cash Dividend", id + ":pre", uri)`
 *     days ahead, then applies the dividend with an instant MultiplierUpdated and
 *     a second Announcement (id without ":pre") in the same transaction.
 *     NVDAc: 1.0 → 1.000537939576369481 on 2026-10-01, tx 0x7aef5d12….
 *   - Each announcement's uri is a record in Coinbase's public API
 *     (/v1/tokenized-stocks/corporate-actions/{id}) with status
 *     ANNOUNCED | APPLIED and multiplier_before / multiplier_after.
 *
 * So the pending-dividend calendar lives in Announcement events, not in the
 * ERC-8056 slots — a reader of only the latter sees "nothing queued" while five
 * dividends are announced. This module reads both events in ONE warehouse query
 * (address-filtered and time-bounded: an unbounded `lower(toString(address))`
 * scan exceeds the warehouse's per-query limit and fails every time) and joins
 * each to Coinbase's record.
 */

import "server-only";
import { cdpSql } from "./covalent";
import { kvGet, kvSet } from "./kv";
import type { TokenizedStock } from "./tokenized-stocks";

/** Tokenized stocks launched in August 2026; nothing earlier exists to read. */
const SINCE = "2026-08-01";

export interface StockAction {
  id: string;
  symbol: string;
  ticker: string;
  token: string;
  /** Issuer's words, e.g. "Cash Dividend". */
  description: string;
  status: "announced" | "applied" | "unknown";
  announcedAt: string | null;
  appliedAt: string | null;
  multiplierBefore: number | null;
  multiplierAfter: number | null;
  /** (after / before − 1) × 100 — the share accrual the holder received. */
  accrualPct: number | null;
  announceTx: string | null;
  applyTx: string | null;
  uri: string | null;
}

interface Row {
  address?: string;
  event_name?: string;
  parameters?: Record<string, string>;
  transaction_hash?: string;
  block_timestamp?: string;
}

interface ApiAction {
  status?: string;
  announced_at?: string;
  applied_at?: string;
  multiplier_before?: number;
  multiplier_after?: number;
  description?: string;
}

/** "abc:pre" and "abc" are the same action — announced, then applied. */
export const baseActionId = (id: string) => id.replace(/:pre$/, "");

/**
 * The action's identity. The uri's last segment is Coinbase's record id and is
 * authoritative: the first announcement ever (GOOGLc, 2026-09-14) carried id
 * "2097" while its uri — and the application three hours later — used the UUID.
 */
export function actionKey(id: string, uri: string | undefined): string {
  const fromUri = uri?.match(/corporate-actions\/([^/?#]+)$/)?.[1];
  return fromUri ? baseActionId(decodeURIComponent(fromUri)) : baseActionId(id);
}

export function accrualPct(before: number | null, after: number | null): number | null {
  if (before === null || after === null || !(before > 0)) return null;
  return Math.round((after / before - 1) * 1e6) / 1e4;
}

/** Fold raw events into one action per id. Pure; exported for tests. */
export function foldActions(rows: readonly Row[], byAddr: Map<string, TokenizedStock>): StockAction[] {
  const acts = new Map<string, StockAction>();
  // Multiplier moves keyed by tx, so the "applied" announcement in the same tx
  // picks up the exact on-chain value.
  const multByTx = new Map<string, string>();
  for (const r of rows) {
    if (r.event_name === "MultiplierUpdated" && r.transaction_hash && r.parameters?.multiplier) {
      multByTx.set(r.transaction_hash, r.parameters.multiplier);
    }
  }
  for (const r of rows) {
    if (r.event_name !== "Announcement") continue;
    const s = byAddr.get(String(r.address ?? "").toLowerCase());
    const rawId = r.parameters?.id;
    if (!s || !rawId) continue;
    const id = actionKey(rawId, r.parameters?.uri);
    const pre = rawId.endsWith(":pre");
    const m = r.transaction_hash ? multByTx.get(r.transaction_hash) : undefined;
    const a = acts.get(id) ?? {
      id,
      symbol: s.sym,
      ticker: s.ticker,
      token: s.token,
      description: r.parameters?.description ?? "corporate action",
      status: "announced" as const,
      announcedAt: null,
      appliedAt: null,
      multiplierBefore: null,
      multiplierAfter: null,
      accrualPct: null,
      announceTx: null,
      applyTx: null,
      uri: r.parameters?.uri ?? null,
    };
    const at = r.block_timestamp ?? null;
    // Applied only when the multiplier moved in the same transaction; any other
    // announcement is notice (Coinbase's record, joined later, can promote it).
    if (pre || !m) {
      if (!a.announcedAt || (at && at < a.announcedAt)) {
        a.announcedAt = at;
        a.announceTx = r.transaction_hash ?? null;
      }
    } else {
      // The un-suffixed announcement is the application (it rides the
      // MultiplierUpdated tx). An action announced and applied at once has no :pre.
      a.status = "applied";
      a.appliedAt = at;
      a.applyTx = r.transaction_hash ?? null;
      a.announcedAt ??= at;
      a.multiplierAfter = Number(BigInt(m) / 10n ** 6n) / 1e12;
    }
    acts.set(id, a);
  }
  return [...acts.values()];
}

async function apiRecord(id: string): Promise<ApiAction | null> {
  const key = `stocks:ca:${id}`;
  const cached = await kvGet(key).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as ApiAction;
    } catch {
      /* refetch */
    }
  }
  const res = await fetch(`https://api.coinbase.com/v1/tokenized-stocks/corporate-actions/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const j = (await res.json().catch(() => null)) as ApiAction | null;
  if (!j) return null;
  // An applied action never changes again; an announced one will.
  const applied = j.status === "CORPORATE_ACTION_STATUS_APPLIED";
  await kvSet(key, JSON.stringify(j), applied ? 30 * 86400 : 3600).catch(() => {});
  return j;
}

/** Overlay Coinbase's record (status, before/after) on the chain-derived action. */
export function applyRecord(a: StockAction, rec: ApiAction | null): StockAction {
  if (!rec) return { ...a, accrualPct: accrualPct(a.multiplierBefore, a.multiplierAfter) };
  const status =
    rec.status === "CORPORATE_ACTION_STATUS_APPLIED" ? "applied" : rec.status === "CORPORATE_ACTION_STATUS_ANNOUNCED" ? "announced" : a.status;
  const before = typeof rec.multiplier_before === "number" ? rec.multiplier_before : a.multiplierBefore;
  const after = typeof rec.multiplier_after === "number" ? rec.multiplier_after : a.multiplierAfter;
  return {
    ...a,
    status,
    description: rec.description ?? a.description,
    announcedAt: rec.announced_at ?? a.announcedAt,
    appliedAt: rec.applied_at ?? a.appliedAt,
    multiplierBefore: before,
    multiplierAfter: after,
    accrualPct: accrualPct(before, after),
  };
}

/**
 * Every announced or applied corporate action across `roster`, newest first.
 * Returns null when the warehouse cannot be read — unknown, never "none".
 */
export async function readStockActions(roster: readonly TokenizedStock[]): Promise<StockAction[] | null> {
  if (roster.length === 0) return [];
  const byAddr = new Map(roster.map((s) => [s.token.toLowerCase(), s]));
  const inList = [...byAddr.keys()].map((a) => `'${a}'`).join(",");
  const rows = await cdpSql<Row>(
    `SELECT address, event_name, parameters, transaction_hash, block_timestamp FROM base.events ` +
      `WHERE event_name IN ('Announcement','MultiplierUpdated') AND address IN (${inList}) ` +
      `AND block_timestamp >= '${SINCE}' ORDER BY block_timestamp DESC LIMIT 1000`,
  );
  if (rows === null) return null;
  const folded = foldActions(rows, byAddr);
  const enriched = await Promise.all(folded.map(async (a) => applyRecord(a, await apiRecord(a.id))));
  const when = (a: StockAction) => a.appliedAt ?? a.announcedAt ?? "";
  return enriched.sort((x, y) => when(y).localeCompare(when(x)));
}
