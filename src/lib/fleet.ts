/**
 * Fleet — spend control for agent swarms on prepaid credit.
 *
 * Someone running twenty agents off one $20 pack has two bad choices today:
 * hand every agent the one token (any of them can drain it, and none can be
 * stopped without stopping all), or buy twenty packs. A fleet adds a third:
 * the holder of a credit token issues CHILD tokens, each with its own daily
 * cap, optional per-call maximum, optional service allowlist and an on/off
 * switch, all spending from the parent's one balance.
 *
 * A child is the same `ck_…` shape as any credit token, so an agent sends it as
 * `x-credit-token` exactly as before. It carries no balance: nothing is minted
 * when it is created, and every cent it spends comes off the parent and lands
 * in `credits:spent` like any other credit call — the liability ledger cannot
 * tell the difference and does not need to.
 *
 * Only hashes are stored. The child secret is returned once, at creation; the
 * child's public id is its hash handle, which is what list/pause/delete use.
 *
 * KV layout (handles are creditHandle(): sha256(token)[0..24]):
 *   fleet:child:<childHandle>                hash  parent, label, cap, max, allow, status, created
 *   fleet:children:<parentHandle>            set   child handles
 *   fleet:spend:<childHandle>:<YYYY-MM-DD>   int   mills charged that UTC day (2-day TTL)
 *
 * Every write here is a script, so it runs on the primary and checks ownership
 * in the same step as the change: a stale replica can never make a pause late
 * or let someone else's parent token touch a child.
 */

import "server-only";
import { randomBytes } from "node:crypto";
import { kvConfigured, kvEval, kvSMembers } from "./kv";
import {
  creditHandle,
  isCreditTokenShape,
  isLiveCreditBalance,
  debitCreditMills,
  refundCreditMills,
  debitChildMills,
  refundChildMills,
  type ChildRefusal,
} from "./credits";
import { getService } from "./services";

/** A child lives as long as a balance does; the parent's own balance TTL is 180 days. */
const CHILD_TTL = 60 * 60 * 24 * 180;
/** Spend counters only need to outlive their UTC day (plus a refund landing just after midnight). */
const SPEND_TTL = 60 * 60 * 48;
export const MAX_CHILDREN = 50;
/** $1,000 a day per child, in mills. Far above any pack we sell; it exists to reject nonsense. */
export const MAX_DAILY_CAP_MILLS = 1_000_000;
const MAX_LABEL = 60;
const MAX_ALLOW = 50;

const recordKey = (childHandle: string) => `fleet:child:${childHandle}`;
const indexKey = (parentHandle: string) => `fleet:children:${parentHandle}`;
const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);
export const spendKey = (childHandle: string, day = utcDay()) => `fleet:spend:${childHandle}:${day}`;

export class FleetError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "FleetError";
  }
}

export interface ChildView {
  id: string;
  label: string;
  status: "active" | "paused";
  dailyCapUsd: number;
  perCallMaxUsd: number | null;
  allow: string[] | null;
  createdAt: string;
  spentTodayUsd: number;
}

const usd = (mills: number) => +(mills / 1000).toFixed(3);

/**
 * Resolve the token presented to a management endpoint into a parent handle.
 * It must be a live balance we minted. A child token has no balance of its own,
 * so it fails that test — and gets told why, rather than a generic "unknown".
 */
export async function authenticateParent(token: string): Promise<string> {
  const t = (token || "").trim();
  if (!kvConfigured()) throw new FleetError("Fleet unavailable: durable storage not configured", 503);
  if (!isCreditTokenShape(t)) throw new FleetError("Send your parent credit token in the `x-credit-token` header.", 401);
  if (await childParent(creditHandle(t))) {
    throw new FleetError("This is a fleet child token. Children cannot create or manage other tokens — use the parent token.", 403);
  }
  if (!(await isLiveCreditBalance(t))) throw new FleetError("Unknown or expired credit token.", 401);
  return creditHandle(t);
}

/** The parent handle a child points at, or null when the handle is not a child. Primary read. */
async function childParent(childHandle: string): Promise<string | null> {
  const r = await kvEval<string | null>("return redis.call('HGET', KEYS[1], 'parent')", [recordKey(childHandle)], []);
  return typeof r === "string" && r ? r : null;
}

export interface ChildInput {
  label?: unknown;
  dailyCapUsd?: unknown;
  perCallMaxUsd?: unknown;
  allow?: unknown;
}

/** Validate a create request into stored form. Throws FleetError(400) with the reason. */
export function parseChildInput(body: ChildInput): { label: string; capMills: number; maxMills: number; allow: string[] } {
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > MAX_LABEL) throw new FleetError(`label is required (1–${MAX_LABEL} characters).`, 400);
  if (/[\u0000-\u001f]/.test(label)) throw new FleetError("label contains control characters.", 400);

  const cap = Number(body.dailyCapUsd);
  const capMills = Math.round(cap * 1000);
  if (!Number.isFinite(cap) || capMills < 1 || capMills > MAX_DAILY_CAP_MILLS) {
    throw new FleetError(`dailyCapUsd is required: a number from 0.001 to ${MAX_DAILY_CAP_MILLS / 1000}.`, 400);
  }

  let maxMills = 0;
  if (body.perCallMaxUsd !== undefined && body.perCallMaxUsd !== null && body.perCallMaxUsd !== "") {
    const max = Number(body.perCallMaxUsd);
    maxMills = Math.round(max * 1000);
    if (!Number.isFinite(max) || maxMills < 1 || maxMills > capMills) {
      throw new FleetError("perCallMaxUsd must be at least 0.001 and no more than dailyCapUsd.", 400);
    }
  }

  let allow: string[] = [];
  if (body.allow !== undefined && body.allow !== null) {
    if (!Array.isArray(body.allow) || body.allow.length > MAX_ALLOW || body.allow.some((s) => typeof s !== "string")) {
      throw new FleetError(`allow must be an array of up to ${MAX_ALLOW} service ids.`, 400);
    }
    allow = [...new Set((body.allow as string[]).map((s) => s.trim()).filter(Boolean))];
    const unknown = allow.filter((id) => !getService(id) || id === "buy-credits");
    if (unknown.length) throw new FleetError(`Not a paid service id: ${unknown.join(", ")}`, 400);
  }
  return { label, capMills, maxMills, allow };
}

const CREATE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return -1 end
if redis.call('SCARD', KEYS[2]) >= tonumber(ARGV[7]) then return -2 end
redis.call('HSET', KEYS[1], 'parent', ARGV[1], 'label', ARGV[2], 'cap', ARGV[3], 'max', ARGV[4], 'allow', ARGV[5], 'status', 'active', 'created', ARGV[6])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[8]))
redis.call('SADD', KEYS[2], ARGV[9])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[8]))
return 1
`;

/** Issue a child token. The secret is in the return value and nowhere else. */
export async function createChild(parentHandle: string, input: ChildInput) {
  const { label, capMills, maxMills, allow } = parseChildInput(input);
  const token = `ck_${randomBytes(18).toString("hex")}`;
  const id = creditHandle(token);
  const createdAt = new Date().toISOString();
  const r = await kvEval<number>(
    CREATE_LUA,
    [recordKey(id), indexKey(parentHandle)],
    [parentHandle, label, capMills, maxMills, allow.length ? `,${allow.join(",")},` : "", createdAt, MAX_CHILDREN, CHILD_TTL, id],
  );
  if (r === null) throw new FleetError("Fleet unavailable: storage did not confirm the write — nothing was created, retry shortly.", 503);
  if (Number(r) === -2) throw new FleetError(`A parent can have at most ${MAX_CHILDREN} children. Delete one first.`, 409);
  if (Number(r) !== 1) throw new FleetError("Could not create the child token, retry.", 503);
  return {
    childToken: token,
    child: {
      id,
      label,
      status: "active" as const,
      dailyCapUsd: usd(capMills),
      perCallMaxUsd: maxMills ? usd(maxMills) : null,
      allow: allow.length ? allow : null,
      createdAt,
      spentTodayUsd: 0,
    } satisfies ChildView,
    security:
      "Shown once — only its hash is stored. The child spends from YOUR balance, within its own limits. Pause or delete it with your parent token; it stops on its next call.",
  };
}

/** KEYS: index, then (record, today's spend) per child. ARGV: parent, then child ids in the same order. */
const LIST_LUA = `
local out = {}
for n = 2, #ARGV do
  local rk = KEYS[2 * n - 2]
  local h = redis.call('HMGET', rk, 'parent', 'label', 'cap', 'max', 'allow', 'status', 'created')
  if not h[1] then
    redis.call('SREM', KEYS[1], ARGV[n])
  elseif h[1] == ARGV[1] then
    table.insert(out, {n - 1, h[2] or '', h[3] or '0', h[4] or '0', h[5] or '', h[6] or '', h[7] or '', redis.call('GET', KEYS[2 * n - 1]) or '0'})
  end
end
return out
`;

/** The parent's children with today's spend. Children whose record expired are dropped from the index. */
export async function listChildren(parentHandle: string): Promise<ChildView[]> {
  const ids = (await kvSMembers(indexKey(parentHandle))).filter((s) => /^[0-9a-f]{24}$/.test(s)).slice(0, MAX_CHILDREN * 2);
  if (!ids.length) return [];
  const keys = [indexKey(parentHandle), ...ids.flatMap((id) => [recordKey(id), spendKey(id)])];
  const rows = await kvEval<Array<[number, string, string, string, string, string, string, string]>>(LIST_LUA, keys, [parentHandle, ...ids]);
  if (!Array.isArray(rows)) throw new FleetError("Fleet unavailable: could not read children, retry shortly.", 503);
  const views: ChildView[] = rows.map((row) => {
    const [n, label, cap, max, allow, status, created, spent] = row;
    return {
      id: ids[Number(n) - 1],
      label: String(label),
      status: status === "paused" ? "paused" : "active",
      dailyCapUsd: usd(Number(cap)),
      perCallMaxUsd: Number(max) > 0 ? usd(Number(max)) : null,
      allow: allow ? String(allow).split(",").filter(Boolean) : null,
      createdAt: String(created),
      spentTodayUsd: usd(Number(spent)),
    };
  });
  return views.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const STATUS_LUA = `
if redis.call('HGET', KEYS[1], 'parent') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
return 1
`;

/** The kill switch. Effective on the child's very next call: the debit script reads status on the primary. */
export async function setChildStatus(parentHandle: string, childId: string, status: "active" | "paused"): Promise<void> {
  if (!/^[0-9a-f]{24}$/.test(childId)) throw new FleetError("No such child.", 404);
  const r = await kvEval<number>(STATUS_LUA, [recordKey(childId)], [parentHandle, status]);
  if (r === null) throw new FleetError("Fleet unavailable: storage did not confirm the change — retry.", 503);
  if (Number(r) !== 1) throw new FleetError("No such child.", 404);
}

const DELETE_LUA = `
if redis.call('HGET', KEYS[1], 'parent') ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[2])
return 1
`;

/** Revoke a child for good. Its token stops working on the next call. */
export async function deleteChild(parentHandle: string, childId: string): Promise<void> {
  if (!/^[0-9a-f]{24}$/.test(childId)) throw new FleetError("No such child.", 404);
  const r = await kvEval<number>(DELETE_LUA, [recordKey(childId), indexKey(parentHandle)], [parentHandle, childId]);
  if (r === null) throw new FleetError("Fleet unavailable: storage did not confirm the delete — retry.", 503);
  if (Number(r) !== 1) throw new FleetError("No such child.", 404);
}

const SUMMARY_LUA = `
local h = redis.call('HMGET', KEYS[1], 'parent', 'label', 'cap', 'max', 'status')
if not h[1] then return false end
return {h[2] or '', h[3] or '0', h[4] or '0', h[5] or '', redis.call('GET', KEYS[2]) or '0'}
`;

/**
 * What a child token may know about itself: its own label, limits and today's
 * spend. Not the parent's balance — a child is handed out to an agent, and how
 * much its owner holds is not that agent's business. Null when not a child.
 */
export async function childSummary(token: string) {
  const t = (token || "").trim();
  if (!kvConfigured() || !isCreditTokenShape(t)) return null;
  const id = creditHandle(t);
  const r = await kvEval<[string, string, string, string, string] | null>(SUMMARY_LUA, [recordKey(id), spendKey(id)], []);
  if (!Array.isArray(r)) return null;
  const [label, cap, max, status, spent] = r;
  return {
    id,
    label: String(label),
    status: status === "paused" ? ("paused" as const) : ("active" as const),
    dailyCapUsd: usd(Number(cap)),
    perCallMaxUsd: Number(max) > 0 ? usd(Number(max)) : null,
    spentTodayUsd: usd(Number(spent)),
    capLeftTodayUsd: usd(Math.max(0, Number(cap) - Number(spent))),
  };
}

// ─── The paid gateway's entry point ─────────────────────────────────────────

export type Charge =
  | { ok: true; remainingMills: number; refund: () => Promise<void>; fleet?: { spentTodayMills: number; capMills: number } }
  | { ok: false; reason: "no_kv" | "bad_token" | "insufficient"; balanceMills: number }
  | { ok: false; reason: ChildRefusal; spentTodayMills: number; capMills: number };

/**
 * Charge a credit token — parent or child — for one call to `serviceId`.
 *
 * A parent pays exactly as before, in one script. Only when that script says
 * the token has no balance of its own do we ask whether it is a child, so an
 * ordinary credit call costs no extra round trip. The `refund` returned undoes
 * this exact charge, on whichever balance (and cap) it landed.
 */
export async function chargeCreditToken(token: string, serviceId: string, mills: number): Promise<Charge> {
  const t = (token || "").trim();
  const debit = await debitCreditMills(t, mills);
  if (debit.ok) return { ok: true, remainingMills: debit.remainingMills, refund: () => refundCreditMills(t, mills) };
  if (debit.reason !== "bad_token" || !isCreditTokenShape(t)) {
    return { ok: false, reason: debit.reason ?? "bad_token", balanceMills: debit.balanceMills ?? 0 };
  }

  const childId = creditHandle(t);
  const parentHandle = await childParent(childId);
  if (!parentHandle) return { ok: false, reason: "bad_token", balanceMills: 0 };
  // Fixed now, not at refund time: a call that straddles midnight is refunded
  // against the day it was counted on.
  const sk = spendKey(childId);
  const c = await debitChildMills({ parentHandle, recordKey: recordKey(childId), spendKey: sk, serviceId, mills, spendTtlSeconds: SPEND_TTL });
  if (!c.ok) {
    if (c.reason === "no_kv") return { ok: false, reason: "no_kv", balanceMills: 0 };
    return { ok: false, reason: c.reason as ChildRefusal, spentTodayMills: c.spentTodayMills, capMills: c.capMills };
  }
  return {
    ok: true,
    remainingMills: c.remainingMills,
    refund: () => refundChildMills({ parentHandle, spendKey: sk, mills }),
    fleet: { spentTodayMills: c.spentTodayMills, capMills: c.capMills },
  };
}

/** What a refused child is told. Every one of these is a policy the parent set, so none is "pay more". */
export function childRefusalMessage(reason: ChildRefusal, spentTodayMills: number, capMills: number): { status: number; error: string } {
  switch (reason) {
    case "paused":
      return { status: 403, error: "This fleet token is paused by its owner. Nothing was charged." };
    case "revoked":
      return { status: 403, error: "This fleet token was deleted by its owner. Nothing was charged." };
    case "not_allowed":
      return { status: 403, error: "This fleet token is not allowed to call this service. Nothing was charged." };
    case "over_call_max":
      return { status: 403, error: "This call costs more than this fleet token's per-call maximum. Nothing was charged." };
    case "daily_cap":
      return {
        status: 403,
        error: `Daily cap reached: $${usd(spentTodayMills)} of $${usd(capMills)} spent today (UTC); this call would exceed it. Nothing was charged. Resets at 00:00 UTC.`,
      };
    case "parent_empty":
      return { status: 402, error: "The balance this fleet token spends from is too low for this call. Nothing was charged." };
    case "parent_gone":
      return { status: 402, error: "The balance this fleet token spends from has expired or was moved by recovery. Nothing was charged." };
  }
}
