/**
 * Token approvals for a Base wallet — the drain surface.
 *
 * This used to come from Covalent (GoldRush). That account hit its credit limit
 * and the upstream now answers "Credit limit exceeded" to every request, which
 * took `approval-advisor` and `ai-wallet-security` down to a hard 500 and broke
 * the mini-app's "Protect wallet" scan — the feature promoted on the home page.
 *
 * GoPlus already backs our token-security checks, is free, and its approval feed
 * is richer for this purpose than the one it replaces: it names the spender
 * contract, flags known-malicious ones, and gives the holder's balance, so the
 * amount actually at risk can be computed rather than taken on trust.
 *
 * The output shape is deliberately identical to the Covalent version's, so the
 * advisor and the AI report keep working untouched.
 *
 * Two honesty rules carried over from the rest of the codebase:
 *   - An upstream that did not answer throws. It must never read as "no
 *     approvals", which is the answer a wallet owner would act on by doing
 *     nothing.
 *   - USD at risk is min(balance, allowance) x price. An approval over tokens
 *     the wallet does not hold cannot drain what is not there, and pricing the
 *     allowance instead produces frightening numbers that are not real.
 */

import "server-only";
import { dexTokenPairs } from "./upstream-cache";

const API = "https://api.gopluslabs.io/api/v2/token_approval_security/8453";
/** Most wallets sit far under this; the cap bounds the price fan-out below. */
const MAX_TOKENS = 30;

interface GoPlusApproval {
  approved_contract?: string;
  approved_amount?: string;
  approved_time?: number;
  address_info?: {
    contract_name?: string | null;
    tag?: string | null;
    is_contract?: number;
    doubt_list?: number;
    malicious_behavior?: string[] | null;
  };
}
interface GoPlusRow {
  token_address?: string;
  token_symbol?: string;
  token_name?: string;
  decimals?: number;
  balance?: string;
  is_open_source?: number;
  malicious_address?: number;
  approved_list?: GoPlusApproval[];
}

function reqAddr(raw: string): string {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… wallet address");
  return v.toLowerCase();
}

/** Deepest-pool USD price for a token, or null when it has no priced market. */
async function priceOf(token: string): Promise<number | null> {
  try {
    const pairs = (await dexTokenPairs<{ baseToken?: { address?: string }; priceUsd?: string; liquidity?: { usd?: number } }>(token)) ?? [];
    const mine = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === token.toLowerCase());
    if (!mine.length) return null;
    const best = mine.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
    const n = parseFloat(String(best.priceUsd ?? ""));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** An allowance at or above this many whole tokens is effectively unlimited. */
const UNLIMITED_AT = 1e15;

export async function tokenApprovals(params: Record<string, string>) {
  const address = reqAddr(params.address || params.wallet || "");

  let rows: GoPlusRow[];
  try {
    const r = await fetch(`${API}?addresses=${address}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`GoPlus responded ${r.status}`);
    const j = (await r.json()) as { code?: number; message?: string; result?: GoPlusRow[] | null };
    // code 1 = ok, 2 = partial data. Anything else is a failure, and a failure
    // must not be served as an empty approval list.
    if (j.code !== 1 && j.code !== 2) throw new Error(`Approval data unavailable: ${j.message ?? "upstream error"}`);
    rows = j.result ?? [];
  } catch (err) {
    if (err instanceof Error && /unavailable/i.test(err.message)) throw err;
    throw new Error(`Approval data unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // GoPlus returns the approval HISTORY, including allowances already set back
  // to zero — on a real wallet that was 29 of 36 rows. A revoked approval cannot
  // drain anything, and listing it as something to revoke is both a wrong answer
  // and busywork for whoever acts on it. Keep only live allowances.
  const live = (a: GoPlusApproval) => (parseFloat(String(a.approved_amount ?? "0")) || 0) > 0;
  let revokedRows = 0;
  const withApprovals = rows
    .map((r) => {
      const all = r.approved_list ?? [];
      const kept = all.filter(live);
      revokedRows += all.length - kept.length;
      return { ...r, approved_list: kept };
    })
    .filter((r) => (r.approved_list?.length ?? 0) > 0)
    .slice(0, MAX_TOKENS);
  // Sequential rather than parallel: DexScreener rate-limits a burst, and a
  // rate-limited price would silently become "nothing at risk".
  const prices = new Map<string, number | null>();
  for (const r of withApprovals) {
    const t = (r.token_address ?? "").toLowerCase();
    if (t && !prices.has(t)) prices.set(t, await priceOf(t));
  }

  const approvals = withApprovals
    .map((r) => {
      const token = (r.token_address ?? "").toLowerCase();
      const price = prices.get(token) ?? null;
      const held = parseFloat(String(r.balance ?? "0")) || 0;
      const spenders = (r.approved_list ?? []).map((a) => {
        const allowance = parseFloat(String(a.approved_amount ?? "0")) || 0;
        const info = a.address_info ?? {};
        const malicious = (info.malicious_behavior?.length ?? 0) > 0 || info.doubt_list === 1 || r.malicious_address === 1;
        // What a spender could actually take today: it cannot move more than the
        // wallet holds, however large the allowance.
        const exposed = Math.min(held, allowance);
        return {
          spender: a.approved_contract ?? null,
          label: info.contract_name || info.tag || null,
          allowance: a.approved_amount ?? null,
          usdAtRisk: price !== null ? +(exposed * price).toFixed(2) : null,
          riskFactor: malicious ? "flagged by GoPlus (malicious or suspicious spender)" : info.is_contract === 0 ? "spender is an EOA, not a contract" : null,
          approvedAt: a.approved_time ? new Date(a.approved_time * 1000).toISOString() : null,
          unlimited: allowance >= UNLIMITED_AT,
        };
      });
      const usdAtRisk = spenders.reduce((s, x) => s + (x.usdAtRisk ?? 0), 0);
      return {
        token: r.token_symbol ?? null,
        tokenAddress: r.token_address ?? null,
        balance: r.balance ?? null,
        priced: price !== null,
        usdAtRisk: +usdAtRisk.toFixed(2),
        spenders,
      };
    })
    .sort((a, b) => (b.usdAtRisk ?? 0) - (a.usdAtRisk ?? 0));

  const unpriced = approvals.filter((a) => !a.priced).length;
  return {
    address,
    approvalCount: approvals.length,
    totalUsdAtRisk: +approvals.reduce((s, a) => s + (a.usdAtRisk ?? 0), 0).toFixed(2),
    approvals,
    // A dollar figure computed over tokens we could not price is not a total.
    // Say so rather than let a partial number read as the whole exposure.
    unpricedTokens: unpriced,
    /** Historical grants already set back to zero — reported, never counted. */
    alreadyRevoked: revokedRows,
    ...(unpriced > 0 ? { degraded: true } : {}),
    source: "goplus",
    note:
      `Only LIVE allowances are listed; ${revokedRows} already-revoked grant(s) were excluded. ` +
      "USD at risk is what a spender could take TODAY: min(balance, allowance) × price. " +
      (unpriced > 0
        ? `${unpriced} of ${approvals.length} approved tokens have no priced market, so the USD total covers only the priced ones. `
        : "") +
      "Revoke unused approvals (e.g. at revoke.cash) to reduce risk. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
