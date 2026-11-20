/**
 * Arbitrum (chain 42161) SPL-of-EVM safety reads — isolated, plain fetch.
 *
 * GoPlus token_security returns the whole security picture for an EVM token in
 * one call: honeypot, buy/sell tax, mint/owner powers, pausable/blacklist,
 * proxy, verification, LP lock and holder concentration. We reuse the same
 * registered-app auth as the Base path (chain-agnostic), just pointed at 42161.
 * Nothing in the Base/NEAR/Solana paths imports this.
 */
import "server-only";
import { goPlusHeaders } from "../goplus-auth";

export const ARBITRUM_CHAIN_ID = "42161";

export interface ArbSecurity {
  tokenName: string | null;
  tokenSymbol: string | null;
  isHoneypot: boolean | null;
  cannotSellAll: boolean | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  isMintable: boolean | null;
  ownerRenounced: boolean;
  canTakeBackOwnership: boolean | null;
  hiddenOwner: boolean | null;
  transferPausable: boolean | null;
  isBlacklisted: boolean | null;
  selfdestruct: boolean | null;
  isProxy: boolean | null;
  isOpenSource: boolean | null;
  holderCount: number | null;
  lpLockedPct: number | null;
  top10Pct: number | null;
}

const bool = (v: unknown): boolean | null => (v === "1" ? true : v === "0" ? false : null);
/** GoPlus returns ratios as decimal strings (0.1 = 10%). */
const toPct = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" && v != null ? n * 100 : null;
};
const ZERO = "0x0000000000000000000000000000000000000000";

/** GoPlus token_security on Arbitrum. Secondary — null on any failure (not fatal). */
export async function arbTokenSecurity(addr: string): Promise<ArbSecurity | null> {
  const url = `https://api.gopluslabs.io/api/v1/token_security/${ARBITRUM_CHAIN_ID}?contract_addresses=${addr}`;
  try {
    const headers = await goPlusHeaders();
    let r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok && headers.authorization) r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: Record<string, Record<string, unknown>> };
    // GoPlus keys the result by the lowercased address.
    const s = j.result?.[addr.toLowerCase()] ?? Object.values(j.result ?? {})[0];
    if (!s) return null;

    const lp = Array.isArray(s.lp_holders) ? (s.lp_holders as Array<{ is_locked?: number; percent?: string }>) : [];
    const lpLocked = lp.filter((h) => h.is_locked === 1).reduce((n, h) => n + (Number(h.percent) || 0), 0) * 100;
    const holders = Array.isArray(s.holders) ? (s.holders as Array<{ percent?: string }>) : [];
    const top10 = holders.slice(0, 10).reduce((n, h) => n + (Number(h.percent) || 0), 0) * 100;
    const owner = typeof s.owner_address === "string" ? s.owner_address : "";

    return {
      tokenName: typeof s.token_name === "string" ? s.token_name : null,
      tokenSymbol: typeof s.token_symbol === "string" ? s.token_symbol : null,
      isHoneypot: bool(s.is_honeypot),
      cannotSellAll: bool(s.cannot_sell_all),
      buyTaxPct: toPct(s.buy_tax),
      sellTaxPct: toPct(s.sell_tax),
      isMintable: bool(s.is_mintable),
      ownerRenounced: owner === "" || owner.toLowerCase() === ZERO,
      canTakeBackOwnership: bool(s.can_take_back_ownership),
      hiddenOwner: bool(s.hidden_owner),
      transferPausable: bool(s.transfer_pausable),
      isBlacklisted: bool(s.is_blacklisted),
      selfdestruct: bool(s.selfdestruct),
      isProxy: bool(s.is_proxy),
      isOpenSource: bool(s.is_open_source),
      holderCount: s.holder_count != null ? Number(s.holder_count) : null,
      lpLockedPct: lp.length ? lpLocked : null,
      top10Pct: holders.length ? top10 : null,
    };
  } catch {
    return null;
  }
}
