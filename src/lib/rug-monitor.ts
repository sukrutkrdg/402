/**
 * Rug Early-Warning Monitor.
 *
 * Agents pay once to watch a Base token's liquidity. A cron snapshots liquidity
 * periodically; if it collapses (a liquidity pull — the moment of a rug), we POST
 * the caller's webhook. This is the alert that actually matters: not price moving,
 * but the pool being drained out from under you.
 *
 * Reuses the price-alert infra (SSRF-safe webhooks + KV). Storage:
 *   rugwatch:{id}    — JSON RugWatch (TTL 30 days)
 *   rugwatch:active  — set of active ids
 */

import "server-only";
import { assertSafeWebhook } from "./alerts";
import { dexTokenPairs } from "./upstream-cache";
import { kvSet, kvGet, kvSAdd, kvSRem, kvSMembers, kvConfigured } from "./kv";

const TTL = 60 * 60 * 24 * 30; // 30 days

export interface RugWatch {
  id: string;
  token: string;
  webhook: string;
  baselineLiquidityUsd: number;
  dropPct: number; // fire when liquidity falls by at least this %
  createdAt: string;
  fired: boolean;
  firedAt?: string;
  firedDropPct?: number;
  firedLiquidityUsd?: number;
}

/**
 * Deepest pool in USD, or null when the price feed could not be read.
 *
 * The distinction is the whole product. This used to throw for BOTH "the feed is
 * down" and "the token has no pool", and every caller swallowed the throw the
 * same way — so a token whose LP had been pulled entirely (no pool left to
 * index) read as a transient blip, and the monitor answered "liquidity still
 * above the drop threshold" for the one event it exists to catch.
 *
 * No pool is not a missing reading. It is a reading of zero.
 */
async function fetchLiquidity(token: string): Promise<number | null> {
  const raw = await dexTokenPairs<{ baseToken?: { address?: string }; liquidity?: { usd?: number } }>(token);
  if (raw === null) return null; // provider unavailable — we know nothing
  const pairs = raw.filter((p) => p.baseToken?.address?.toLowerCase() === token.toLowerCase());
  if (pairs.length === 0) return 0; // provider answered: this token has no pool
  return pairs.reduce((m, p) => Math.max(m, p.liquidity?.usd ?? 0), 0);
}

/** Paid entry point — register a rug-watch. */
export async function registerRugMonitor(params: Record<string, string>): Promise<unknown> {
  if (!kvConfigured()) throw new Error("Monitor unavailable: durable storage not configured");

  // Poll mode — check a previously registered monitor by id (no webhook needed).
  // This is how a stateless MCP agent (no inbound endpoint) uses monitors: pay
  // once to register, then re-check on its own schedule.
  const checkId = (params.check || "").trim();
  if (checkId) {
    const raw = await kvGet(`rugwatch:${checkId}`);
    if (!raw) return { found: false, note: "No monitor with that id (expired or never registered)." };
    const w = JSON.parse(raw) as RugWatch;
    let current: number | null = null;
    try {
      current = await fetchLiquidity(w.token);
    } catch {
      /* transient */
    }
    const dropNow = current !== null && w.baselineLiquidityUsd > 0 ? +(100 * (1 - current / w.baselineLiquidityUsd)).toFixed(1) : null;
    // A reading we could not take must never be answered as "nothing happened":
    // "ok" is the field an agent branches on, and asserting it while blind is
    // how a drained pool got reported as healthy.
    const verdict = w.fired
      ? "RUG_WARNING_FIRED"
      : dropNow === null
        ? "unknown"
        : dropNow >= w.dropPct
          ? "THRESHOLD_MET"
          : "ok";
    return {
      found: true, id: w.id, token: w.token, fired: w.fired,
      baselineLiquidityUsd: w.baselineLiquidityUsd,
      currentLiquidityUsd: current !== null ? +current.toFixed(0) : null,
      dropPct: dropNow, firesAtDropPct: w.dropPct,
      firedAt: w.firedAt ?? null, firedLiquidityUsd: w.firedLiquidityUsd ?? null,
      verdict,
      ...(dropNow === null ? { degraded: true } : {}),
      note: w.fired
        ? `⚠️ Liquidity collapsed — this monitor fired${w.firedAt ? ` at ${w.firedAt}` : ""}.`
        : dropNow === null
          ? "Liquidity could not be read on this check (price feed unavailable) — this is NOT a reading of 'no change'. Re-check shortly."
          : dropNow >= w.dropPct
            ? `⚠️ Liquidity is ${dropNow}% below the baseline — at or past your ${w.dropPct}% threshold.`
            : "Monitor active; liquidity still above the drop threshold. Re-check anytime with check=<id>.",
      checkedAt: new Date().toISOString(),
    };
  }

  const token = (params.token || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("Invalid token: must be a 0x… 40-hex Base contract address");

  const dropPct = Math.min(95, Math.max(10, parseFloat(params.dropPct || "50") || 50));
  // Webhook is OPTIONAL: with one we POST on fire; without, the caller polls check=<id>.
  const wh = (params.webhook || "").trim();
  const url = wh ? await assertSafeWebhook(wh) : null;

  const baseline = await fetchLiquidity(token);
  if (baseline === null) throw new Error("Liquidity feed unavailable — cannot establish a baseline right now, retry shortly");
  if (baseline <= 0) throw new Error("Token has no measurable liquidity to monitor");

  const id = `${token.slice(2, 10)}-${Date.now().toString(36)}`;
  const watch: RugWatch = {
    id,
    token,
    webhook: url ? url.toString() : "",
    baselineLiquidityUsd: +baseline.toFixed(0),
    dropPct,
    createdAt: new Date().toISOString(),
    fired: false,
  };
  await kvSet(`rugwatch:${id}`, JSON.stringify(watch), TTL);
  await kvSAdd("rugwatch:active", id);

  return {
    registered: true,
    id,
    token,
    baselineLiquidityUsd: watch.baselineLiquidityUsd,
    firesWhenLiquidityDropsPct: dropPct,
    webhook: watch.webhook || null,
    mode: watch.webhook ? "webhook" : "poll",
    expiresInDays: 30,
    note: watch.webhook
      ? `We'll POST your webhook if ${token}'s liquidity falls ${dropPct}%+ from the $${watch.baselineLiquidityUsd.toLocaleString()} baseline.`
      : `Poll mode (no webhook): re-check anytime by calling this service with check=${watch.id}. We fire when liquidity falls ${dropPct}%+ from $${watch.baselineLiquidityUsd.toLocaleString()}.`,
  };
}

/** Cron entry point — check all active rug-watches, fire webhooks on liquidity collapse. */
export async function checkRugMonitors(): Promise<{ checked: number; fired: number }> {
  if (!kvConfigured()) return { checked: 0, fired: 0 };
  const ids = await kvSMembers("rugwatch:active");
  let fired = 0;
  for (const id of ids) {
    const raw = await kvGet(`rugwatch:${id}`);
    if (!raw) {
      await kvSRem("rugwatch:active", id);
      continue;
    }
    let w: RugWatch;
    try {
      w = JSON.parse(raw) as RugWatch;
    } catch {
      await kvSRem("rugwatch:active", id);
      continue;
    }
    if (w.fired) {
      await kvSRem("rugwatch:active", id);
      continue;
    }
    let current: number | null;
    try {
      current = await fetchLiquidity(w.token);
    } catch {
      continue; // transient — retry next run
    }
    // null is "we could not look", which is not evidence of anything. Zero is a
    // pool that is gone — the case the webhook exists for, and the one that used
    // to be indistinguishable from an outage and so never fired.
    if (current === null) continue;
    const dropPct = w.baselineLiquidityUsd > 0 ? 100 * (1 - current / w.baselineLiquidityUsd) : 0;
    if (dropPct >= w.dropPct) {
      // Deliver only if a webhook was set (poll-mode monitors just record state).
      if (w.webhook) {
      try {
        await assertSafeWebhook(w.webhook);
        await fetch(w.webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "rug_warning",
            token: w.token,
            baselineLiquidityUsd: w.baselineLiquidityUsd,
            currentLiquidityUsd: +current.toFixed(0),
            dropPct: +dropPct.toFixed(1),
            firedAt: new Date().toISOString(),
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
        });
      } catch {
        /* delivery best-effort */
      }
      }
      w.fired = true;
      w.firedAt = new Date().toISOString();
      w.firedDropPct = +dropPct.toFixed(1);
      w.firedLiquidityUsd = +current.toFixed(0);
      await kvSet(`rugwatch:${w.id}`, JSON.stringify(w), TTL);
      await kvSRem("rugwatch:active", w.id);
      fired++;
    }
  }
  return { checked: ids.length, fired };
}
