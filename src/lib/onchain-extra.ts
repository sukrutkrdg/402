/**
 * Additional on-chain utility services for the x402 Bazaar.
 *
 * Three complementary endpoints that pair naturally with the flagship
 * tokenRisk / addressIntel handlers in onchain.ts:
 *
 *   gasOracle  — live Base gas estimates for agents deciding tx timing/cost.
 *   tokenPrice — DEX price + liquidity for any Base token via DexScreener.
 *   txDecode   — quick structural decode of any Base transaction hash.
 *
 * All three use public / free data sources: Base RPC (via viem) and the
 * DexScreener public API. No upstream API keys required.
 */

import "server-only";
import {
  createPublicClient,
  http,
  formatGwei,
  formatEther,
  getAddress,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { getConfig } from "@/lib/config";

// ---------------------------------------------------------------------------
// Shared helpers (mirrors onchain.ts — kept local to avoid coupling)
// ---------------------------------------------------------------------------

function client() {
  return createPublicClient({ chain: base, transport: http(getConfig().rpcUrl, { timeout: 8000 }) });
}

/** Validates a checksummed 0x…40-hex address; throws a user-facing message on failure. */
function requireAddress(raw: string): Address {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… address");
  return getAddress(v);
}

// ---------------------------------------------------------------------------
// 1. gasOracle — current Base gas estimates
// ---------------------------------------------------------------------------

/**
 * Returns live Base gas estimates derived from `estimateFeesPerGas` and the
 * latest block's `baseFeePerGas`. All values are in Gwei for easy consumption
 * by trading bots and agents comparing tx costs.
 *
 * No params required — the network state is the only input.
 */
export async function gasOracle(_params: Record<string, string>) {
  const c = client();

  // Fetch fee estimates and latest block in parallel for a consistent snapshot.
  let fees, block;
  try {
    [fees, block] = await Promise.all([
      c.estimateFeesPerGas(),
      c.getBlock({ blockTag: "latest" }),
    ]);
  } catch (err) {
    throw new Error(`Gas oracle unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const baseFee =
    block.baseFeePerGas ??
    (fees.maxFeePerGas !== undefined ? fees.maxFeePerGas - fees.maxPriorityFeePerGas : 0n);
  const maxPriorityFee = fees.maxPriorityFeePerGas;

  // Derive slow / normal / fast tip tiers as simple multipliers of the suggested
  // maxPriorityFeePerGas.  Slow = 80 %, normal = 100 %, fast = 150 %.
  const slow = (maxPriorityFee * 80n) / 100n;
  const normal = maxPriorityFee;
  const fast = (maxPriorityFee * 150n) / 100n;

  return {
    baseFeeGwei: formatGwei(baseFee),
    maxPriorityFeeGwei: formatGwei(maxPriorityFee),
    suggested: {
      slow: formatGwei(slow),
      normal: formatGwei(normal),
      fast: formatGwei(fast),
    },
    blockNumber: String(block.number),
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 2. tokenPrice — DEX price + liquidity via DexScreener public API
// ---------------------------------------------------------------------------

interface DexScreenerPair {
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  priceNative?: string;
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  fdv?: number;
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[] | null;
}

/**
 * Fetches price and liquidity for a Base token from the free DexScreener
 * public API.  The pair with the highest USD liquidity is selected so the
 * returned price reflects the most active / canonical market.
 *
 * Throws (preventing buyer charge) when no pair data is found.
 *
 * params.address — token contract address (required, checksummed 0x…40-hex).
 */
export async function tokenPrice(params: Record<string, string>) {
  const address = requireAddress(params.address || "");

  let data: DexScreenerResponse;
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`DexScreener responded ${res.status}`);
    data = (await res.json()) as DexScreenerResponse;
  } catch (err) {
    // Re-throw with a clearer message so the caller knows it's a network issue.
    throw new Error(`Price fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pairs = data.pairs?.filter(Boolean) ?? [];
  if (pairs.length === 0) {
    throw new Error("No price data found for this token");
  }

  const addrLc = address.toLowerCase();
  const highestLiq = (arr: DexScreenerPair[]) =>
    arr.reduce((top, p) => ((p.liquidity?.usd ?? 0) > (top.liquidity?.usd ?? 0) ? p : top), arr[0]);

  // Only trust pairs where the queried token is the BASE token — that's the pair
  // whose priceUsd is this token's price. (Picking by liquidity alone returns the
  // wrong price for tokens that are usually the quote side, e.g. USDC.)
  const baseMatches = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === addrLc);

  let best: DexScreenerPair;
  let priceUsd: string | null;
  if (baseMatches.length > 0) {
    best = highestLiq(baseMatches);
    priceUsd = best.priceUsd ?? null;
  } else {
    // Token only appears as the quote side — derive its USD from base/priceNative.
    best = highestLiq(pairs);
    const baseUsd = parseFloat(best.priceUsd ?? "");
    const native = parseFloat(best.priceNative ?? "");
    priceUsd =
      Number.isFinite(baseUsd) && Number.isFinite(native) && native > 0
        ? String(baseUsd / native)
        : null;
  }

  if (!priceUsd) {
    throw new Error("No price data found for this token");
  }

  // Report the queried token's own metadata (it's the base in baseMatches,
  // otherwise the quote in the fallback pair).
  const self =
    best.baseToken?.address?.toLowerCase() === addrLc ? best.baseToken : best.quoteToken;

  return {
    address,
    priceUsd,
    priceChange24h: best.priceChange?.h24 ?? null,
    liquidityUsd: best.liquidity?.usd ?? null,
    volume24h: best.volume?.h24 ?? null,
    dexId: best.dexId ?? null,
    pairAddress: best.pairAddress ?? null,
    baseToken: {
      name: self?.name ?? null,
      symbol: self?.symbol ?? null,
    },
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Batch price lookup for up to 10 Base tokens in one call. Each token is priced
 * via the same base-token-matched logic as tokenPrice; failures are reported
 * per-token (the call still succeeds for the rest).
 *
 * params.addresses — comma-separated 0x… token addresses.
 */
export async function multiTokenPrice(params: Record<string, string>) {
  const list = (params.addresses || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s))
    .slice(0, 10);
  if (list.length === 0)
    throw new Error("Provide 'addresses' — comma-separated valid 0x… token addresses");

  const results = await Promise.all(
    list.map(async (a) => {
      try {
        const p = await tokenPrice({ address: a });
        return {
          address: a,
          priceUsd: p.priceUsd,
          symbol: p.baseToken.symbol,
          priceChange24h: p.priceChange24h,
        };
      } catch (e) {
        return { address: a, error: e instanceof Error ? e.message : "lookup failed" };
      }
    }),
  );

  // Don't charge if nothing resolved (e.g. upstream down for the whole batch).
  if (results.every((r) => "error" in r)) {
    throw new Error("No price data for any of the provided tokens");
  }

  return { count: results.length, results, checkedAt: new Date().toISOString() };
}

/**
 * DEX pair (pool) info for a specific Base pair address: price, liquidity,
 * 24h volume, buy/sell counts, FDV. For agents analysing a specific pool.
 *
 * params.pair — the pair/pool contract address (0x…40-hex).
 */
export async function pairInfo(params: Record<string, string>) {
  const pair = (params.pair || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(pair)) throw new Error("Provide a valid 0x… pair address");

  let data: { pairs?: DexScreenerPair[] | null; pair?: DexScreenerPair | null };
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/base/${pair}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`DexScreener responded ${res.status}`);
    data = await res.json();
  } catch (err) {
    throw new Error(`Pair fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const p = (Array.isArray(data.pairs) ? data.pairs[0] : data.pair) ?? null;
  if (!p) throw new Error("No data found for this pair");

  return {
    pairAddress: pair,
    dexId: p.dexId ?? null,
    baseToken: { name: p.baseToken?.name ?? null, symbol: p.baseToken?.symbol ?? null, address: p.baseToken?.address ?? null },
    quoteToken: { symbol: p.quoteToken?.symbol ?? null, address: p.quoteToken?.address ?? null },
    priceUsd: p.priceUsd ?? null,
    priceChange24h: p.priceChange?.h24 ?? null,
    liquidityUsd: p.liquidity?.usd ?? null,
    volume24h: p.volume?.h24 ?? null,
    txns24h: p.txns?.h24 ? { buys: p.txns.h24.buys ?? null, sells: p.txns.h24.sells ?? null } : null,
    fdv: p.fdv ?? null,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 3. txDecode — structural decode of a Base transaction
// ---------------------------------------------------------------------------

/**
 * Fetches a Base transaction and its receipt then returns a structured summary
 * useful for block explorers, debugging, and agent pipelines.
 *
 * Throws (preventing buyer charge) when the hash is invalid or not found.
 *
 * params.hash — 66-char hex transaction hash (required, 0x + 64 hex digits).
 */
export async function txDecode(params: Record<string, string>) {
  const raw = (params.hash || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("Provide a valid 0x… transaction hash (66 hex characters)");
  }
  const hash = raw as `0x${string}`;

  const c = client();

  // Fetch transaction and receipt in parallel — both must exist for a confirmed tx.
  const [tx, receipt] = await Promise.allSettled([
    c.getTransaction({ hash }),
    c.getTransactionReceipt({ hash }),
  ]);

  if (tx.status === "rejected" || !tx.value) {
    throw new Error("Transaction not found on Base mainnet");
  }

  const t = tx.value;
  const r = receipt.status === "fulfilled" ? receipt.value : null;

  // Method selector = first 4 bytes of calldata (0x + 8 hex chars), or null for
  // plain ETH transfers where input is "0x".
  const methodSelector =
    t.input && t.input.length >= 10 ? (t.input.slice(0, 10) as string) : null;

  return {
    hash: t.hash,
    from: t.from,
    to: t.to ?? null,
    valueEth: formatEther(t.value),
    status: r ? r.status : null,
    gasUsed: r ? String(r.gasUsed) : null,
    blockNumber: t.blockNumber !== null ? String(t.blockNumber) : null,
    methodSelector,
    nonce: t.nonce,
    checkedAt: new Date().toISOString(),
  };
}
