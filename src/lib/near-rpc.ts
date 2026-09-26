/**
 * Shared NEAR plumbing for the NEAR-native services: JSON-RPC queries with
 * fallback, view calls, unit formatting, and NEAR Intents' token list.
 *
 * Free, public sources only. Every failure that is ours to retry surfaces as an
 * Error whose message says "not charged" — the route turns a thrown handler into
 * a non-2xx, so x402 never settles and a credit debit is refunded.
 */

import "server-only";

/** Tried in order; the first that answers wins. Override with NEAR_RPC_URL. */
export const RPCS = () =>
  (process.env.NEAR_RPC_URL ? [process.env.NEAR_RPC_URL] : []).concat([
    "https://rpc.mainnet.fastnear.com",
    "https://rpc.mainnet.near.org",
  ]);

/** A NEAR account id: 2–64 chars, lowercase, `.`-separated parts of [a-z0-9_-]. */
export const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** view_account's code_hash when nothing is deployed. */
export const EMPTY_CODE_HASH = "11111111111111111111111111111111";

export type RpcResult<T> = { ok: true; value: T } | { ok: false; unknownAccount: boolean; message: string };

export async function rpcQuery<T>(params: Record<string, unknown>): Promise<RpcResult<T>> {
  let last = "no RPC reachable";
  for (const url of RPCS()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "402", method: "query", params: { finality: "final", ...params } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        last = `${url} HTTP ${res.status}`;
        continue;
      }
      const j = (await res.json()) as {
        result?: T & { error?: string };
        error?: { cause?: { name?: string }; message?: string; data?: string };
      };
      if (j.error) {
        const name = j.error.cause?.name ?? "";
        return {
          ok: false,
          unknownAccount: name === "UNKNOWN_ACCOUNT" || /does not exist/i.test(j.error.data ?? ""),
          message: name || j.error.message || "rpc error",
        };
      }
      // Older nodes report view-call failures inside `result.error`.
      if (j.result && typeof j.result.error === "string") {
        return { ok: false, unknownAccount: /does not exist/i.test(j.result.error), message: j.result.error.slice(0, 200) };
      }
      if (j.result) return { ok: true, value: j.result };
      last = `${url} empty result`;
    } catch (e) {
      last = `${url} ${(e as Error).name}`;
    }
  }
  throw new Error(`NEAR RPC unavailable (${last}) — not charged, retry shortly`);
}

/** A contract view call; null when the method is missing, panics, or does not return JSON. */
export async function viewCall<T>(accountId: string, method: string, args: Record<string, unknown> = {}): Promise<T | null> {
  const r = await rpcQuery<{ result: number[] }>({
    request_type: "call_function",
    account_id: accountId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (!r.ok) return null;
  try {
    return JSON.parse(Buffer.from(r.value.result).toString("utf8")) as T;
  } catch {
    return null;
  }
}

export interface IntentsToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  contractAddress?: string;
}

let tokenCache: { at: number; v: IntentsToken[] } | null = null;

/** NEAR Intents' routable assets (1Click /v0/tokens), cached 5 min per instance. Null if unreachable. */
export async function intentsTokens(): Promise<IntentsToken[] | null> {
  if (tokenCache && Date.now() - tokenCache.at < 300_000) return tokenCache.v;
  try {
    const res = await fetch("https://1click.chaindefuser.com/v0/tokens", { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const v = (await res.json()) as IntentsToken[];
    tokenCache = { at: Date.now(), v };
    return v;
  } catch {
    return null;
  }
}

/** Test hook. */
export function _resetNearCaches() {
  tokenCache = null;
}

/** The NEAR-chain entry for a NEP-141 contract account, if NEAR Intents routes it. */
export function findNearToken(tokens: IntentsToken[], accountId: string): IntentsToken | undefined {
  return tokens.find((t) => t.blockchain === "near" && (t.contractAddress === accountId || t.assetId === `nep141:${accountId}`));
}

/** Is this token routed by NEAR Intents, and at what price? Null if the list is unreachable. */
export async function nearIntentsListing(accountId: string): Promise<{ listed: boolean; priceUsd: number | null } | null> {
  const tokens = await intentsTokens();
  if (!tokens) return null;
  const hit = findNearToken(tokens, accountId);
  return { listed: Boolean(hit), priceUsd: hit?.price ?? null };
}

export function formatUnits(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return raw;
  const s = raw.padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals) || "0";
  // Cut to 6 places first, then drop trailing zeros — "3.0000001" reads as "3", not "3.000000".
  const frac = decimals ? s.slice(s.length - decimals).slice(0, 6).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
}

/** Human decimal string → base-unit integer string; null when it is not a positive amount. */
export function parseUnits(human: string, decimals: number): string | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec((human || "").trim());
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  const raw = (m[1] + frac).replace(/^0+(?=\d)/, "");
  return /^0+$/.test(raw) ? null : raw;
}

/** yoctoNEAR (10^-24) per byte of storage an account must keep locked. */
export const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;

/** Registrar suffixes: `alice.near` is an ordinary name, not a meaningful sub-account of `near`. */
const REGISTRARS = new Set(["near", "tg"]);

/** What kind of NEAR account id this is. */
export function accountKind(id: string): "implicit" | "eth-implicit" | "named" | "top-level" | "sub-account" {
  if (/^[0-9a-f]{64}$/.test(id)) return "implicit";
  if (/^0x[0-9a-f]{40}$/.test(id)) return "eth-implicit";
  const parts = id.split(".");
  if (parts.length === 1) return "top-level";
  if (parts.length === 2 && REGISTRARS.has(parts[1])) return "named";
  return "sub-account";
}

/**
 * Archival reads — state as of a past block, for anything measured over time
 * (a staking token's price a week ago). Regular RPC nodes keep only recent
 * blocks, so these go to archival nodes. Override with NEAR_ARCHIVAL_RPC_URL.
 */
export const ARCHIVAL_RPCS = () =>
  (process.env.NEAR_ARCHIVAL_RPC_URL ? [process.env.NEAR_ARCHIVAL_RPC_URL] : []).concat([
    "https://archival-rpc.mainnet.fastnear.com",
    "https://archival-rpc.mainnet.near.org",
  ]);

async function archival<T>(method: string, params: Record<string, unknown>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  let last = "no archival RPC reachable";
  for (const url of ARCHIVAL_RPCS()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "402", method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        last = `${url} HTTP ${res.status}`;
        continue;
      }
      const j = (await res.json()) as { result?: T & { error?: string }; error?: { cause?: { name?: string }; message?: string } };
      if (j.error) return { ok: false, message: j.error.cause?.name || j.error.message || "rpc error" };
      if (j.result && typeof j.result.error === "string") return { ok: false, message: j.result.error.slice(0, 200) };
      if (j.result) return { ok: true, value: j.result };
      last = `${url} empty result`;
    } catch (e) {
      last = `${url} ${(e as Error).name}`;
    }
  }
  throw new Error(`NEAR archival RPC unavailable (${last}) — not charged, retry shortly`);
}

/** A block's height and time (ms). `at` is a height, or "final" for the latest. Null when the height was skipped. */
export async function blockAt(at: number | "final"): Promise<{ height: number; timeMs: number } | null> {
  const r = await archival<{ header: { height: number; timestamp: number | string; timestamp_nanosec?: string } }>(
    "block",
    at === "final" ? { finality: "final" } : { block_id: at },
  );
  if (!r.ok) return null;
  const ns = String(r.value.header.timestamp_nanosec ?? r.value.header.timestamp);
  return { height: r.value.header.height, timeMs: Number(ns.slice(0, ns.length - 6)) };
}

/** The nearest existing block at or after `height` (NEAR skips some heights). */
export async function blockNear(height: number): Promise<{ height: number; timeMs: number } | null> {
  for (let h = height; h < height + 5; h++) {
    const b = await blockAt(h);
    if (b) return b;
  }
  return null;
}

/** A view call as of a past block; null when it fails. */
export async function viewCallAt<T>(accountId: string, method: string, blockId: number, args: Record<string, unknown> = {}): Promise<T | null> {
  const r = await archival<{ result: number[] }>("query", {
    request_type: "call_function",
    block_id: blockId,
    account_id: accountId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (!r.ok) return null;
  try {
    return JSON.parse(Buffer.from(r.value.result).toString("utf8")) as T;
  } catch {
    return null;
  }
}
