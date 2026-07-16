/**
 * Spend Permission Auditor — the agent-era wallet safety check for Base Account.
 *
 * Base Account "Spend Permissions" (SpendPermissionManager 0xf852…67Ad) are the
 * primitive that lets a user grant an app/agent scoped, recurring spend authority
 * (token + allowance + period). It's how autonomous agents actually move money on
 * Base — and, like ERC-20 approvals, an over-broad grant is a drain vector.
 *
 * This reads a wallet's SpendPermissionApproved / SpendPermissionRevoked history
 * (CDP-indexed onchain events), reconstructs the CURRENTLY-active permissions, and
 * flags the risky ones: unlimited allowance, no expiry, and unrecognized spenders.
 * approval-advisor covers ERC-20 allowances; this covers the Base-native spend
 * permissions that ERC-20 tools can't see. Deterministic, no LLM.
 */

import "server-only";
import { cdpSql } from "./covalent";

const MANAGER = "0xf85210b21cc50302f477ba56686d2019dc9b67ad";
const UINT160_MAX = (1n << 160n) - 1n;
// An allowance within a factor of the type ceiling is effectively unlimited.
const NEAR_UNLIMITED = UINT160_MAX - (UINT160_MAX >> 8n);

interface EvtRow {
  event_signature?: string | null;
  parameters?: unknown;
  block_timestamp?: string | null;
  transaction_hash?: string | null;
}

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const lc = (v: unknown) => String(v ?? "").toLowerCase();

/**
 * The event carries `(bytes32 hash, SpendPermission spendPermission)`. CDP SQL may
 * flatten the struct differently across indexer versions: nested object, flat
 * fields, or (current indexer) a single tuple STRING of the form
 * "{0xAccount 0xSpender 0xToken allowance period start end salt [extraData]}"
 * in struct order. Pull each field from wherever it lands.
 */
function readPerm(parameters: unknown): { hash: string; account: string; spender: string; token: string; allowance: string; period: string; start: string; end: string } | null {
  const p = (parameters ?? {}) as Record<string, unknown>;
  const hash = String(p.hash ?? p.permissionHash ?? "");
  const raw = p.spendPermission ?? p.spend_permission ?? p;
  if (typeof raw === "string") {
    // Tuple-string form; struct order: account spender token allowance period start end salt extraData
    const parts = raw.replace(/^\{|\}$/g, "").trim().split(/\s+/);
    const [account, spender, token, allowance, period, start, end] = parts;
    if (!isAddr(lc(account ?? "")) || !isAddr(lc(spender ?? ""))) return null;
    return {
      hash,
      account: lc(account), spender: lc(spender), token: lc(token ?? ""),
      allowance: allowance ?? "0", period: period ?? "0", start: start ?? "0", end: end ?? "0",
    };
  }
  const sp = raw as Record<string, unknown>;
  const account = lc(sp.account);
  const spender = lc(sp.spender);
  const token = lc(sp.token);
  if (!isAddr(account) || !isAddr(spender)) return null;
  return {
    hash,
    account, spender, token,
    allowance: String(sp.allowance ?? "0"),
    period: String(sp.period ?? "0"),
    start: String(sp.start ?? "0"),
    end: String(sp.end ?? "0"),
  };
}

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // ERC-7528 native sentinel

export async function spendAudit(params: Record<string, string>) {
  const wallet = (params.wallet || params.address || params.account || "").trim();
  if (!isAddr(wallet)) throw new Error("Provide a wallet address (wallet=)");
  const w = wallet.toLowerCase();

  // Filter to THIS wallet's events IN SQL. The account lives inside the
  // (non-indexed) SpendPermission tuple string, so match the address
  // case-insensitively within it — the manager is a network-wide singleton and
  // an unfiltered scan (LIMIT 5000, ASC) would drop this wallet's recent grants
  // once the contract passes 5000 events/year, silently reporting "none".
  // `w` is validated `0x`+40-hex, so the interpolation is injection-safe.
  const needle = w.slice(2);
  const rows = await cdpSql<EvtRow>(
    `SELECT event_signature, parameters, block_timestamp, transaction_hash
     FROM base.events
     WHERE address = '${MANAGER}'
       AND (event_signature LIKE 'SpendPermissionApproved%' OR event_signature LIKE 'SpendPermissionRevoked%')
       AND positionCaseInsensitive(toString(parameters['spendPermission']), '${needle}') > 0
       AND block_timestamp > now() - INTERVAL 365 DAY
     ORDER BY block_timestamp ASC
     LIMIT 5000`,
  );
  if (rows === null) throw new Error("Spend permission data unavailable (data provider) — try again shortly");
  // A single account hitting 5000 events in a year is implausible; if it happens
  // the replay is incomplete, so fail loud rather than under-report active grants.
  if (rows.length >= 5000) throw new Error("Too many spend-permission events to reconstruct reliably — narrow the window");

  // Replay approvals/revocations for THIS account; a later revoke of the same
  // permission hash cancels an earlier approval.
  const active = new Map<string, { perm: ReturnType<typeof readPerm>; at: string | null; tx: string | null }>();
  for (const r of rows) {
    const perm = readPerm(r.parameters);
    if (!perm || perm.account !== w) continue;
    const revoked = /Revoked/i.test(r.event_signature ?? "");
    const key = perm.hash || `${perm.spender}:${perm.token}:${perm.period}:${perm.start}`;
    if (revoked) active.delete(key);
    else active.set(key, { perm, at: r.block_timestamp ?? null, tx: r.transaction_hash ?? null });
  }

  const now = Math.floor(Date.now() / 1000);
  const permissions = [...active.values()].map(({ perm, at }) => {
    const allowance = BigInt(perm!.allowance || "0");
    const end = Number(perm!.end || "0");
    const period = Number(perm!.period || "0");
    const unlimited = allowance >= NEAR_UNLIMITED;
    // 0 and uint48-max both appear in the wild as "never expires"; >5y ≈ perpetual too.
    const noExpiry = end === 0 || end > now + 60 * 60 * 24 * 365 * 5;
    const expired = !noExpiry && end < now;
    // A SHORT period is the drain vector: the spender can re-pull the full
    // allowance every period (period=1s + $5 allowance = $432k/day authority).
    const shortPeriod = period > 0 && period <= 3600 && allowance > 0n && !expired;
    const flags: string[] = [];
    if (unlimited) flags.push("UNLIMITED allowance per period");
    if (noExpiry) flags.push("no/near-infinite expiry");
    if (shortPeriod) flags.push(`short ${period}s period — allowance re-spendable ${Math.round(86400 / period).toLocaleString("en-US")}×/day`);
    if (period >= 60 * 60 * 24 * 30) flags.push(`long ${Math.round(period / 86400)}-day period`);
    const risk = expired ? "expired" : (unlimited || shortPeriod) && noExpiry ? "high" : unlimited || noExpiry || shortPeriod ? "medium" : "low";
    return {
      spender: perm!.spender,
      token: perm!.token === NATIVE ? "ETH (native)" : perm!.token,
      allowancePerPeriod: unlimited ? "unlimited" : allowance.toString(),
      periodSeconds: period,
      endsAt: noExpiry ? "never" : new Date(end * 1000).toISOString(),
      grantedAt: at,
      expired,
      risk,
      flags,
    };
  });

  const activeNow = permissions.filter((p) => !p.expired);
  const high = activeNow.filter((p) => p.risk === "high");
  const verdict = high.length ? "action_required" : activeNow.some((p) => p.risk === "medium") ? "review" : activeNow.length ? "ok" : "none";

  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return {
    wallet,
    activeCount: activeNow.length,
    highRiskCount: high.length,
    verdict, // action_required | review | ok | none
    permissions: activeNow.sort((a, b) => (rank[a.risk] ?? 9) - (rank[b.risk] ?? 9)),
    recommendation:
      high.length ? `⚠️ ${high.length} spend permission(s) grant effectively unbounded, non-expiring authority (unlimited allowance and/or rapid re-spend period) — revoke any you don't recognize; a spender can pull the full allowance every period.`
        : activeNow.length ? `${activeNow.length} active spend permission(s). Confirm each spender is one you intend to keep funding, and prefer scoped allowances with an expiry.`
          : "No active Base Account spend permissions found for this wallet.",
    note: "Reconstructs a wallet's active Base Account spend permissions (SpendPermissionManager) from onchain approve/revoke events and flags unlimited/non-expiring grants — the agent-era drain vector ERC-20 approval tools can't see. Revoke via the Base Account app. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
