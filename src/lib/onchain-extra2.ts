/**
 * Extended on-chain utility services for the x402 Bazaar — batch 2.
 *
 * Two complementary endpoints that round out the portfolio intelligence suite:
 *
 *   walletTokens   — full Base token portfolio for an address (ETH + major ERC-20s,
 *                    with optional USD values via DexScreener).
 *   trendingTokens — trending Base pools via GeckoTerminal (boosts listed separately) — was the DexScreener
 *                    token-boosts API.
 *
 * Both use public / free data sources: Base RPC (via viem) and the DexScreener
 * public API. No upstream API keys required.
 */

import "server-only";
import {
  createPublicClient,
  http,
  getAddress,
  formatEther,
  formatUnits,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { getConfig } from "@/lib/config";
import { baseTransport } from "@/lib/base-transport";
import { deepestPool, type DexPoolLike } from "@/lib/dex-pool";

// ---------------------------------------------------------------------------
// Shared helpers (mirrors onchain.ts / onchain-extra.ts — kept local)
// ---------------------------------------------------------------------------

function client() {
  return createPublicClient({ chain: base, transport: baseTransport(8000) });
}

/** Validates a checksummed 0x…40-hex address; throws a user-facing message on failure. */
function requireAddress(raw: string): Address {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… address");
  return getAddress(v);
}

// ---------------------------------------------------------------------------
// Minimal ERC-20 ABI (balanceOf + decimals only — what we need here)
// ---------------------------------------------------------------------------

const minErc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

// ---------------------------------------------------------------------------
// Curated list of major Base tokens
// ---------------------------------------------------------------------------

interface TokenMeta {
  symbol: string;
  address: Address;
  /** Known static decimals — used as fallback if the RPC call fails. */
  decimals: number;
}

const BASE_TOKENS: TokenMeta[] = [
  { symbol: "WETH",  address: "0x4200000000000000000000000000000000000006" as Address, decimals: 18 },
  { symbol: "USDC",  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address, decimals: 6  },
  { symbol: "USDbC", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" as Address, decimals: 6  },
  { symbol: "DAI",   address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" as Address, decimals: 18 },
  { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as Address, decimals: 18 },
];

// ---------------------------------------------------------------------------
// DexScreener type helpers
// ---------------------------------------------------------------------------

interface DexPair {
  chainId?: string;
  priceUsd?: string | null;
  liquidity?: { usd?: number };
}

interface DexTokensResponse {
  pairs?: DexPair[] | null;
}

interface DexBoostToken {
  chainId?: string;
  tokenAddress?: string;
  description?: string;
  totalAmount?: number;
  amount?: number;
  url?: string;
  icon?: string;
}

// ---------------------------------------------------------------------------
// 1. walletTokens — portfolio of major Base tokens for an address
// ---------------------------------------------------------------------------

/**
 * Returns a portfolio snapshot for a Base address: native ETH balance plus
 * balances for a curated set of major Base ERC-20 tokens (WETH, USDC, USDbC,
 * DAI, cbETH). Optionally enriches each balance with a USD value sourced from
 * a single batched DexScreener call.
 *
 * Only throws on an invalid address — empty portfolios are a valid (paid)
 * answer. Price enrichment is best-effort; if the DexScreener call fails the
 * response is still returned without USD values.
 *
 * params.address — Base wallet address (required, checksummed 0x…40-hex).
 */
export async function walletTokens(params: Record<string, string>) {
  const address = requireAddress(params.address || "");
  const c = client();

  // ── 1a. Native ETH balance ──────────────────────────────────────────────
  let ethBalance: bigint;
  try {
    ethBalance = await c.getBalance({ address });
  } catch (err) {
    throw new Error(`Wallet data unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ethBalanceFormatted = formatEther(ethBalance);

  // ── 1b. ERC-20 balances (one readContract call per token, errors skipped) ─
  interface TokenResult {
    symbol: string;
    address: Address;
    rawBalance: bigint;
    decimals: number;
    balance: string;
  }

  const tokenResults: TokenResult[] = [];

  await Promise.all(
    BASE_TOKENS.map(async (token) => {
      try {
        const [rawBalance, rawDecimals] = await Promise.all([
          c.readContract({
            address: token.address,
            abi: minErc20Abi,
            functionName: "balanceOf",
            args: [address],
          }) as Promise<bigint>,
          c.readContract({
            address: token.address,
            abi: minErc20Abi,
            functionName: "decimals",
          }).then((d) => Number(d)).catch(() => token.decimals),
        ]);

        // Only include tokens the wallet actually holds.
        if (rawBalance > 0n) {
          tokenResults.push({
            symbol: token.symbol,
            address: token.address,
            rawBalance,
            decimals: rawDecimals,
            balance: formatUnits(rawBalance, rawDecimals),
          });
        }
      } catch {
        // Skip tokens whose calls fail — do not let one bad token abort the request.
      }
    }),
  );

  // ── 1c. Optional USD pricing via a single batched DexScreener call ───────
  // Build address list: all curated token addresses (ETH will use WETH price).
  const tokenAddresses = BASE_TOKENS.map((t) => t.address).join(",");

  // Map: lowercased address → USD price string
  const priceMap = new Map<string, number>();

  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddresses}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (res.ok) {
      const data = (await res.json()) as DexTokensResponse;
      const pairs = data.pairs?.filter(Boolean) ?? [];

      // DexScreener /latest/dex/tokens/{addrs} returns pairs for ALL requested
      // addresses mixed together, so match each token to its own pairs by
      // baseToken/quoteToken address and pick the highest-liquidity one.
      // priceUsd is the BASE token's price. Taking it from a pair where the
      // token is the quote side priced USDC at ETH's price (3.78 USDC read as
      // $9,173 on 2026-10-17); deepestPool derives the quote side's own price.
      const detailedPairs = pairs as DexPoolLike[];

      for (const token of BASE_TOKENS) {
        const deep = deepestPool(detailedPairs, token.address);
        if (deep?.priceUsd !== null && deep?.priceUsd !== undefined) priceMap.set(token.address.toLowerCase(), deep.priceUsd);
      }
    }
  } catch {
    // Price enrichment is best-effort — silently omit USD values on failure.
  }

  // ── 1d. Assemble the response ─────────────────────────────────────────────
  const wethPrice = priceMap.get("0x4200000000000000000000000000000000000006");

  const ethBalanceNum = parseFloat(ethBalanceFormatted);
  const ethUsdValue =
    wethPrice !== undefined && Number.isFinite(ethBalanceNum)
      ? ethBalanceNum * wethPrice
      : undefined;

  const tokens = tokenResults.map((t) => {
    const price = priceMap.get(t.address.toLowerCase());
    const balanceNum = parseFloat(t.balance);
    const usdValue =
      price !== undefined && Number.isFinite(balanceNum)
        ? balanceNum * price
        : undefined;
    return {
      symbol: t.symbol,
      address: t.address,
      balance: t.balance,
      ...(usdValue !== undefined ? { usdValue } : {}),
    };
  });

  // totalUsd: sum ETH + all tokens (only when we have at least some prices).
  const hasPrices = ethUsdValue !== undefined || tokens.some((t) => "usdValue" in t);
  const totalUsd = hasPrices
    ? (ethUsdValue ?? 0) +
      tokens.reduce((sum, t) => sum + (("usdValue" in t ? (t as { usdValue: number }).usdValue : undefined) ?? 0), 0)
    : undefined;

  return {
    address,
    eth: {
      balance: ethBalanceFormatted,
      ...(ethUsdValue !== undefined ? { usdValue: ethUsdValue } : {}),
    },
    tokens,
    ...(totalUsd !== undefined ? { totalUsd } : {}),
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 2. trendingTokens — trending pools on Base (GeckoTerminal) + promoted tokens
// ---------------------------------------------------------------------------

interface GtPool {
  attributes?: {
    name?: string;
    address?: string;
    reserve_in_usd?: string;
    base_token_price_usd?: string;
    volume_usd?: { h24?: string };
    price_change_percentage?: { h24?: string };
    transactions?: { h24?: { buys?: number; sells?: number } };
  };
  relationships?: { base_token?: { data?: { id?: string } }; dex?: { data?: { id?: string } } };
}

/**
 * What is trending on Base DEXes right now.
 *
 * This used to be DexScreener's token-boosts feed — tokens whose teams PAID to
 * be promoted, sold as "trending". It is also usually empty for Base: on
 * 2026-10-17 it held 30 boosts and none on Base, so the endpoint charged for an
 * empty list (and ai-market-brief told agents there was "zero trending
 * activity"). GeckoTerminal ranks Base pools by live activity, free and keyless.
 * Boosts are still reported, separately and labelled as paid promotion.
 *
 * Throws (not charged) only when the trending feed itself cannot be read.
 */
export async function trendingTokens(_params: Record<string, string>) {
  let pools: GtPool[];
  try {
    const res = await fetch("https://api.geckoterminal.com/api/v2/networks/base/trending_pools?page=1", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GeckoTerminal responded ${res.status}`);
    pools = ((await res.json()) as { data?: GtPool[] }).data ?? [];
    if (!Array.isArray(pools)) throw new Error("unexpected response format");
  } catch (err) {
    throw new Error(`Trending data unavailable: ${err instanceof Error ? err.message : String(err)} — not charged, retry shortly`);
  }

  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const tokens = pools.slice(0, 15).map((p, i) => {
    const a = p.attributes ?? {};
    const id = p.relationships?.base_token?.data?.id ?? "";
    return {
      rank: i + 1,
      tokenAddress: id.startsWith("base_") ? id.slice(5) : null,
      pool: a.name ?? null,
      poolAddress: a.address ?? null,
      dex: p.relationships?.dex?.data?.id ?? null,
      priceUsd: num(a.base_token_price_usd),
      priceChange24hPct: num(a.price_change_percentage?.h24),
      volume24hUsd: num(a.volume_usd?.h24),
      liquidityUsd: num(a.reserve_in_usd),
      txns24h: a.transactions?.h24 ? (a.transactions.h24.buys ?? 0) + (a.transactions.h24.sells ?? 0) : null,
    };
  });

  // Paid promotion, best-effort and never mixed into the ranking.
  let promoted: Array<{ tokenAddress: string | null; amount: number | null }> = [];
  try {
    const res = await fetch("https://api.dexscreener.com/token-boosts/latest/v1", { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const raw = (await res.json()) as DexBoostToken[];
      if (Array.isArray(raw)) {
        promoted = raw
          .filter((t) => t.chainId === "base")
          .slice(0, 10)
          .map((t) => ({ tokenAddress: t.tokenAddress ?? null, amount: t.totalAmount ?? t.amount ?? null }));
      }
    }
  } catch {
    /* promotion feed is optional */
  }

  return {
    chain: "base",
    source: "GeckoTerminal trending pools (live DEX activity)",
    count: tokens.length,
    tokens,
    promoted,
    note: "Trending = ranked by live pool activity, not quality or safety. A trending pool can be a fresh rug: vet with token-risk or pre-trade-gate before buying. `promoted` lists tokens whose teams paid DexScreener for visibility. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
