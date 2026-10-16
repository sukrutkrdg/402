/**
 * GoPlus access token, for the higher rate limit of a registered app.
 *
 * Anonymous GoPlus calls share a low per-minute limit. Under it, token-risk,
 * sellability, owner-powers and dump-risk read "security feed unavailable" on a
 * burst, and the gates fall back to HOLD. A registered app (free plan included)
 * gets its own quota.
 *
 * Auth is app_key + app_secret: sign = sha1(app_key + time + app_secret), POST
 * /api/v1/token, then send `Authorization: <access_token>` (bare; see style). An X-API-KEY
 * header is silently ignored by GoPlus (tested 2026-10-16: a wrong key answered
 * the same as the right one), so the key alone does nothing.
 *
 * Without both env vars, or when the token call fails, this returns null and
 * callers stay anonymous: a credentials problem must never break a check.
 */

import "server-only";
import { createHash } from "node:crypto";
import { kvGet, kvSet } from "./kv";

const TOKEN_URL = "https://api.gopluslabs.io/api/v1/token";

let cached: { token: string; until: number } | null = null;
let inflight: Promise<string | null> | null = null;
/** After a failed token call, stay anonymous for a while instead of retrying on every request. */
let backoffUntil = 0;
/** Why the last token attempt ended as it did — for /api/status, never the token itself. */
let lastOutcome: "app" | "not_configured" | "refused" | "unreachable" = "not_configured";
/** KV keys shared by every instance: when a data call last succeeded on our
 *  token, and when one was last rejected (4012) and fell back to anonymous. */
const OK_KEY = "goplus:auth:lastAcceptedAt";
const REJECT_KEY = "goplus:auth:lastRejectedAt";
let okWrittenAt = 0;
/**
 * How to send the token. GoPlus documents "Bearer <token>", but measured on
 * 2026-10-16 its data endpoints refuse that (4012) and accept the bare token.
 * So the bare token goes first; on a refusal we try Bearer once; if that is
 * refused too, the token is not used for an hour and calls stay anonymous —
 * never a token request per call.
 */
let style: "bearer" | "raw" | "off" = "raw";
let styleOffUntil = 0;

/** A data call carried our token and GoPlus answered code 1. One KV write per instance per 10 minutes. */
export function noteGoPlusTokenAccepted(): void {
  if (Date.now() - okWrittenAt < 10 * 60_000) return;
  okWrittenAt = Date.now();
  kvSet(OK_KEY, `${Date.now()}:${style}`, 7 * 86400).catch(() => {});
}

function creds(): { key: string; secret: string } | null {
  const key = (process.env.GOPLUS_APP_KEY || process.env.GOPLUS_API_KEY || "").trim();
  const secret = (process.env.GOPLUS_APP_SECRET || "").trim();
  return key && secret ? { key, secret } : null;
}

export function goPlusSign(key: string, time: number, secret: string): string {
  return createHash("sha1").update(`${key}${time}${secret}`).digest("hex");
}

async function fetchToken(): Promise<string | null> {
  const c = creds();
  if (!c) return null;
  const time = Math.floor(Date.now() / 1000);
  try {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_key: c.key, sign: goPlusSign(c.key, time, c.secret), time }),
      signal: AbortSignal.timeout(6000),
    });
    const j = (await r.json().catch(() => null)) as { code?: number; result?: { access_token?: string; expires_in?: number } } | null;
    const token = j?.code === 1 ? j.result?.access_token : undefined;
    if (!token) {
      backoffUntil = Date.now() + 5 * 60_000;
      lastOutcome = "refused";
      return null;
    }
    lastOutcome = "app";
    // Refresh a minute early; assume an hour if GoPlus does not say.
    const ttlMs = Math.max(60, (j?.result?.expires_in ?? 3600) - 60) * 1000;
    cached = { token, until: Date.now() + ttlMs };
    return token;
  } catch {
    backoffUntil = Date.now() + 60_000;
    lastOutcome = "unreachable";
    return null;
  }
}

/** A valid access token, or null to call anonymously. Never throws. */
export async function goPlusToken(): Promise<string | null> {
  if (cached && Date.now() < cached.until) return cached.token;
  if (Date.now() < backoffUntil || !creds()) return null;
  if (!inflight) inflight = fetchToken().finally(() => (inflight = null));
  return inflight;
}

/** Headers for a GoPlus request: our token when we have one (form per `style`), nothing otherwise. */
export async function goPlusHeaders(): Promise<Record<string, string>> {
  if (style === "off") {
    if (Date.now() < styleOffUntil) return {};
    style = "raw";
  }
  const t = await goPlusToken();
  if (!t) return {};
  return { authorization: style === "raw" ? t : `Bearer ${t}` };
}

/** Which header form GoPlus accepted last (for /api/status). */
export function goPlusHeaderStyle(): string {
  return style;
}

/**
 * How we reach GoPlus right now: "app" (our registered quota) or "anonymous"
 * with the reason. Tries for a token if none is cached. Safe to publish.
 */
export async function goPlusAuthState(): Promise<{
  mode: "app" | "anonymous";
  reason?: string;
  tokenLastAcceptedAt?: string | null;
  tokenLastRejectedAt?: string | null;
}> {
  if (!creds()) return { mode: "anonymous", reason: "GOPLUS_APP_KEY / GOPLUS_APP_SECRET not set" };
  const t = await goPlusToken();
  if (!t) return { mode: "anonymous", reason: lastOutcome === "refused" ? "GoPlus refused the app credentials" : "GoPlus token endpoint unreachable" };
  // Stored as "<ms>:<header form>".
  const iso = (v: string | null) => {
    const [ms, form] = String(v ?? "").split(":");
    return Number(ms) > 0 ? `${new Date(Number(ms)).toISOString()}${form ? ` (${form})` : ""}` : null;
  };
  const [ok, rej] = await Promise.all([kvGet(OK_KEY).catch(() => null), kvGet(REJECT_KEY).catch(() => null)]);
  return { mode: "app", tokenLastAcceptedAt: iso(ok), tokenLastRejectedAt: iso(rej) };
}

/** Drop a token GoPlus rejected, so the next call fetches a fresh one. */
/** GoPlus refused the token on a data call: try the other form, then stop using it for an hour. */
export function invalidateGoPlusToken(): void {
  kvSet(REJECT_KEY, `${Date.now()}:${style}`, 7 * 86400).catch(() => {});
  if (style === "raw") {
    style = "bearer"; // keep the token: it may be fine in the other form
    return;
  }
  style = "off";
  styleOffUntil = Date.now() + 60 * 60_000;
  cached = null;
}

/** Test hook. */
export function resetGoPlusAuth(): void {
  cached = null;
  inflight = null;
  backoffUntil = 0;
  lastOutcome = "not_configured";
  okWrittenAt = 0;
  style = "raw";
  styleOffUntil = 0;
}
