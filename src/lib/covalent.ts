/**
 * Covalent (GoldRush) powered services (require COVALENT_API_KEY):
 *   walletNetworth — full ERC-20 portfolio with reliable USD (Covalent prices).
 *   walletSummary  — tx count + first/last activity + wallet age (sybil/rug check).
 *   walletActivity — recent decoded transactions.
 *
 * Responses are cached in KV (short TTL) to conserve API credits.
 */

import "server-only";
import { getAddress, formatUnits, formatEther } from "viem";
import { kvGet, kvSet } from "./kv";

const API = "https://api.covalenthq.com/v1";
const CHAIN = "base-mainnet";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function key(): string {
  const k = process.env.COVALENT_API_KEY?.trim();
  if (!k) throw new Error("Wallet data not configured: set COVALENT_API_KEY");
  return k;
}
function reqAddr(raw: string): string {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… address");
  return getAddress(v);
}

async function cov<T>(path: string, cacheKey: string, ttl = 300): Promise<T> {
  try {
    const cached = await kvGet(`cov:${cacheKey}`);
    if (cached) return JSON.parse(cached) as T;
  } catch {
    /* ignore */
  }
  const k = key();
  let lastErr = "unknown";
  for (let i = 0; i < 2; i++) {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        headers: { Authorization: `Bearer ${k}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await sleep(700);
      continue;
    }
    const j = (await res.json().catch(() => ({ error: true, error_message: `HTTP ${res.status}` }))) as {
      error?: boolean;
      error_message?: string;
      error_code?: number;
      data?: T;
    };
    if (j.error) {
      lastErr = j.error_message || `HTTP ${res.status}`;
      // 551 = Covalent worker timeout; retry transient/5xx once.
      if (j.error_code === 551 || res.status >= 500) {
        await sleep(900);
        continue;
      }
      throw new Error(`Covalent: ${lastErr}`);
    }
    try {
      await kvSet(`cov:${cacheKey}`, JSON.stringify(j.data), ttl);
    } catch {
      /* ignore */
    }
    return j.data as T;
  }
  throw new Error(`Covalent unavailable: ${lastErr}`);
}

// ---------------------------------------------------------------------------

interface CovBalItem {
  contract_ticker_symbol?: string;
  contract_name?: string;
  contract_address?: string;
  contract_decimals?: number;
  balance?: string;
  quote?: number | null;
  is_spam?: boolean;
  is_native_token?: boolean;
}

export async function walletNetworth(params: Record<string, string>) {
  const address = reqAddr(params.address || "");
  const data = await cov<{ items?: CovBalItem[] }>(
    `/${CHAIN}/address/${address}/balances_v2/?quote-currency=USD&no-nft-fetch=true`,
    `bal:${address.toLowerCase()}`,
    60,
  );
  const holdings = (data.items ?? [])
    .filter((i) => !i.is_spam && i.balance && i.balance !== "0")
    .map((i) => {
      let bal = 0;
      try {
        bal = parseFloat(formatUnits(BigInt(i.balance as string), i.contract_decimals ?? 18));
      } catch {
        bal = 0;
      }
      return {
        symbol: i.contract_ticker_symbol ?? null,
        name: i.contract_name ?? null,
        address: i.contract_address ?? null,
        native: Boolean(i.is_native_token),
        balance: bal > 0 ? String(bal) : "0",
        usdValue: typeof i.quote === "number" ? +i.quote.toFixed(2) : null,
      };
    })
    .filter((h) => parseFloat(h.balance) > 1e-9)
    .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))
    .slice(0, 50);

  const totalUsd = +holdings.reduce((s, h) => s + (h.usdValue ?? 0), 0).toFixed(2);
  return { address, totalUsd, tokenCount: holdings.length, holdings, source: "covalent", checkedAt: new Date().toISOString() };
}

interface CovTxSummary {
  total_count?: number;
  earliest_transaction?: { block_signed_at?: string; tx_hash?: string };
  latest_transaction?: { block_signed_at?: string; tx_hash?: string };
}

export async function walletSummary(params: Record<string, string>) {
  const address = reqAddr(params.address || "");
  const data = await cov<{ items?: CovTxSummary[] }>(
    `/${CHAIN}/address/${address}/transactions_summary/`,
    `sum:${address.toLowerCase()}`,
    120,
  );
  const s = data.items?.[0] ?? {};
  const firstAt = s.earliest_transaction?.block_signed_at ?? null;
  const lastAt = s.latest_transaction?.block_signed_at ?? null;
  const ageDays = firstAt ? Math.floor((Date.now() - new Date(firstAt).getTime()) / 86400000) : null;
  return {
    address,
    txCount: s.total_count ?? 0,
    firstActivity: firstAt,
    lastActivity: lastAt,
    ageDays,
    activity: (s.total_count ?? 0) === 0 ? "no_activity" : (s.total_count ?? 0) < 10 ? "low" : (s.total_count ?? 0) < 1000 ? "active" : "very_active",
    checkedAt: new Date().toISOString(),
  };
}

interface CovTx {
  tx_hash?: string;
  block_signed_at?: string;
  from_address?: string;
  to_address?: string;
  value?: string;
  successful?: boolean;
}

export async function walletActivity(params: Record<string, string>) {
  const address = reqAddr(params.address || "");
  const data = await cov<{ items?: CovTx[] }>(
    `/${CHAIN}/address/${address}/transactions_v3/?page-size=15&no-logs=true`,
    `tx:${address.toLowerCase()}`,
    60,
  );
  const transactions = (data.items ?? []).slice(0, 15).map((t) => {
    let valueEth = "0";
    try {
      valueEth = t.value ? formatEther(BigInt(t.value)) : "0";
    } catch {
      valueEth = "0";
    }
    return {
      hash: t.tx_hash ?? null,
      time: t.block_signed_at ?? null,
      from: t.from_address ?? null,
      to: t.to_address ?? null,
      valueEth,
      success: t.successful ?? null,
    };
  });
  return { address, count: transactions.length, transactions, checkedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Token approvals (allowance risk — revoke.cash style)
// ---------------------------------------------------------------------------

interface CovSpender {
  spender_address?: string;
  spender_address_label?: string | null;
  allowance?: string;
  value_at_risk_quote?: number | null;
  risk_factor?: string | null;
}
interface CovApproval {
  token_address?: string;
  ticker_symbol?: string;
  value_at_risk_quote?: number | null;
  spenders?: CovSpender[];
}

export async function tokenApprovals(params: Record<string, string>) {
  const address = reqAddr(params.address || "");
  const data = await cov<{ items?: CovApproval[] }>(
    `/${CHAIN}/approvals/${address}/`,
    `appr:${address.toLowerCase()}`,
    120,
  );
  const approvals = (data.items ?? [])
    .map((i) => ({
      token: i.ticker_symbol ?? null,
      tokenAddress: i.token_address ?? null,
      usdAtRisk: typeof i.value_at_risk_quote === "number" ? +i.value_at_risk_quote.toFixed(2) : null,
      spenders: (i.spenders ?? []).map((s) => ({
        spender: s.spender_address ?? null,
        label: s.spender_address_label ?? null,
        allowance: s.allowance ?? null,
        usdAtRisk: typeof s.value_at_risk_quote === "number" ? +s.value_at_risk_quote.toFixed(2) : null,
        riskFactor: s.risk_factor ?? null,
      })),
    }))
    .filter((a) => a.spenders.length > 0)
    .sort((a, b) => (b.usdAtRisk ?? 0) - (a.usdAtRisk ?? 0))
    .slice(0, 30);
  const totalUsdAtRisk = +approvals.reduce((s, a) => s + (a.usdAtRisk ?? 0), 0).toFixed(2);
  return {
    address,
    approvalCount: approvals.length,
    totalUsdAtRisk,
    approvals,
    note: "Revoke unused approvals (e.g. at revoke.cash) to reduce risk.",
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Historical token price (USD at a date)
// ---------------------------------------------------------------------------

export async function historicalPrice(params: Record<string, string>) {
  const token = reqAddr(params.address || params.token || "");
  const date = (params.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Provide 'date' as YYYY-MM-DD");
  const data = await cov<Array<{ prices?: Array<{ date?: string; price?: number }> }>>(
    `/pricing/historical_by_addresses_v2/${CHAIN}/USD/${token}/?from=${date}&to=${date}`,
    `hp:${token.toLowerCase()}:${date}`,
    86400,
  );
  const prices = data?.[0]?.prices ?? [];
  const match = prices.find((p) => p.date === date) ?? prices[0];
  if (!match || typeof match.price !== "number") throw new Error("No price for that token/date");
  return { token, date, priceUsd: match.price, checkedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Wallet NFT holdings
// ---------------------------------------------------------------------------

interface CovNft {
  contract_name?: string;
  contract_ticker_symbol?: string;
  contract_address?: string;
  is_spam?: boolean;
  balance?: string;
  floor_price_quote?: number | null;
}

export async function walletNfts(params: Record<string, string>) {
  const address = reqAddr(params.address || "");
  const data = await cov<{ items?: CovNft[] }>(
    `/${CHAIN}/address/${address}/balances_nft/?no-spam=true&page-size=20`,
    `nft:${address.toLowerCase()}`,
    120,
  );
  const collections = (data.items ?? [])
    .filter((i) => !i.is_spam && i.contract_address)
    .map((i) => ({
      name: i.contract_name ?? null,
      symbol: i.contract_ticker_symbol ?? null,
      address: i.contract_address ?? null,
      count: Number(i.balance ?? 0),
      floorEth: typeof i.floor_price_quote === "number" ? i.floor_price_quote : null,
    }))
    .slice(0, 30);
  return { address, collectionCount: collections.length, collections, checkedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Token transfer history (a wallet's in/out transfers of one token)
// ---------------------------------------------------------------------------

interface CovTransfer {
  transfer_type?: string;
  delta?: string;
  delta_quote?: number | null;
  from_address?: string;
  to_address?: string;
  tx_hash?: string;
  block_signed_at?: string;
  contract_decimals?: number;
  contract_ticker_symbol?: string;
}

export async function tokenTransfers(params: Record<string, string>) {
  const wallet = reqAddr(params.address || "");
  const tokenRaw = (params.token || params.contract || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenRaw)) {
    throw new Error("Provide 'token' — a 0x… token contract address");
  }
  const token = getAddress(tokenRaw);
  const data = await cov<{ items?: Array<{ transfers?: CovTransfer[] }> }>(
    `/${CHAIN}/address/${wallet}/transfers_v2/?contract-address=${token}&page-size=15`,
    `xfer:${wallet.toLowerCase()}:${token.toLowerCase()}`,
    60,
  );
  const all = (data.items ?? []).flatMap((it) => it.transfers ?? []);
  const transfers = all.slice(0, 20).map((t) => {
    let amount = "0";
    try {
      amount = t.delta ? formatUnits(BigInt(t.delta), t.contract_decimals ?? 18) : "0";
    } catch {
      amount = "0";
    }
    return {
      type: t.transfer_type ?? null, // IN | OUT
      amount,
      usd: typeof t.delta_quote === "number" ? +t.delta_quote.toFixed(2) : null,
      from: t.from_address ?? null,
      to: t.to_address ?? null,
      txHash: t.tx_hash ?? null,
      time: t.block_signed_at ?? null,
    };
  });
  return {
    wallet,
    token,
    symbol: all[0]?.contract_ticker_symbol ?? null,
    count: transfers.length,
    transfers,
    checkedAt: new Date().toISOString(),
  };
}
