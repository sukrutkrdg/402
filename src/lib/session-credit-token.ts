/**
 * The prepaid credit token as the terminal and workflow pages hold it: in
 * sessionStorage only, so it dies with the tab and is never sent anywhere except
 * as the `x-credit-token` header of a call the user typed.
 */

const KEY = "bazaar_session_credit_token";

export const CREDIT_TOKEN_RE = /^ck_[0-9a-f]{36}$/;

export function loadSessionToken(): string {
  try {
    return sessionStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

export function saveSessionToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage disabled — the token just won't survive a reload */
  }
}

export const maskToken = (t: string) => (t ? `${t.slice(0, 7)}…${t.slice(-4)}` : "");
