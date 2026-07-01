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
}

async function fetchLiquidity(token: string): Promise<number> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`DexScreener responded ${res.status}`);
  const j = (await res.json()) as { pairs?: Array<{ baseToken?: { address?: string }; liquidity?: { usd?: number } }> | null };
  const pairs = (j.pairs ?? []).filter((p) => p.baseToken?.address?.toLowerCase() === token.toLowerCase());
  if (pairs.length === 0) throw new Error("No liquidity pool for token");
  return pairs.reduce((m, p) => Math.max(m, p.liquidity?.usd ?? 0), 0);
}

/** Paid entry point — register a rug-watch. */
export async function registerRugMonitor(params: Record<string, string>): Promise<unknown> {
  if (!kvConfigured()) throw new Error("Monitor unavailable: durable storage not configured");

  const token = (params.token || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("Invalid token: must be a 0x… 40-hex Base contract address");

  const dropPct = Math.min(95, Math.max(10, parseFloat(params.dropPct || "50") || 50));
  const url = await assertSafeWebhook(params.webhook || "");

  const baseline = await fetchLiquidity(token);
  if (baseline <= 0) throw new Error("Token has no measurable liquidity to monitor");

  const id = `${token.slice(2, 10)}-${Date.now().toString(36)}`;
  const watch: RugWatch = {
    id,
    token,
    webhook: url.toString(),
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
    webhook: watch.webhook,
    expiresInDays: 30,
    note: `We'll POST your webhook if ${token}'s liquidity falls ${dropPct}%+ from the $${watch.baselineLiquidityUsd.toLocaleString()} baseline. Checked on each monitor cron run.`,
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
    let current: number;
    try {
      current = await fetchLiquidity(w.token);
    } catch {
      continue; // transient — retry next run
    }
    const dropPct = w.baselineLiquidityUsd > 0 ? 100 * (1 - current / w.baselineLiquidityUsd) : 0;
    if (dropPct >= w.dropPct) {
      // Re-check webhook safety right before delivery (DNS-rebinding defense).
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
      w.fired = true;
      await kvSet(`rugwatch:${w.id}`, JSON.stringify(w), TTL);
      await kvSRem("rugwatch:active", w.id);
      fired++;
    }
  }
  return { checked: ids.length, fired };
}
