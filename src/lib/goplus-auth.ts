/**
 * GoPlus access token, for the higher rate limit of a registered app.
 *
 * Anonymous GoPlus calls share a low per-minute limit. Under it, token-risk,
 * sellability, owner-powers and dump-risk read "security feed unavailable" on a
 * burst, and the gates fall back to HOLD. A registered app (free plan included)
 * gets its own quota.
 *
 * Auth is app_key + app_secret: sign = sha1(app_key + time + app_secret), POST
 * /api/v1/token, then send `Authorization: Bearer <access_token>`. An X-API-KEY
 * header is silently ignored by GoPlus (tested 2026-10-16: a wrong key answered
 * the same as the right one), so the key alone does nothing.
 *
 * Without both env vars, or when the token call fails, this returns null and
 * callers stay anonymous: a credentials problem must never break a check.
 */

import "server-only";
import { createHash } from "node:crypto";

const TOKEN_URL = "https://api.gopluslabs.io/api/v1/token";

let cached: { token: string; until: number } | null = null;
let inflight: Promise<string | null> | null = null;
/** After a failed token call, stay anonymous for a while instead of retrying on every request. */
let backoffUntil = 0;

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
      return null;
    }
    // Refresh a minute early; assume an hour if GoPlus does not say.
    const ttlMs = Math.max(60, (j?.result?.expires_in ?? 3600) - 60) * 1000;
    cached = { token, until: Date.now() + ttlMs };
    return token;
  } catch {
    backoffUntil = Date.now() + 60_000;
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

/** Headers for a GoPlus request: Bearer when we have a token, nothing otherwise. */
export async function goPlusHeaders(): Promise<Record<string, string>> {
  const t = await goPlusToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

/** Drop a token GoPlus rejected, so the next call fetches a fresh one. */
export function invalidateGoPlusToken(): void {
  cached = null;
}

/** Test hook. */
export function resetGoPlusAuth(): void {
  cached = null;
  inflight = null;
  backoffUntil = 0;
}
