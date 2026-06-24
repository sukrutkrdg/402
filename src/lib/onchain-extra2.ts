/**
 * Extended on-chain utility services for the x402 Bazaar — batch 2.
 *
 * Two complementary endpoints that round out the portfolio intelligence suite:
 *
 *   walletTokens   — full Base token portfolio for an address (ETH + major ERC-20s,
 *                    with optional USD values via DexScreener).
 *   trendingTokens — current boosted / trending tokens on Base via the DexScreener
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

// ---------------------------------------------------------------------------
// Shared helpers (mirrors onchain.ts / onchain-extra.ts — kept local)
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
      interface DetailedPair extends DexPair {
        baseToken?: { address?: string };
        quoteToken?: { address?: string };
      }
      const detailedPairs = pairs as DetailedPair[];

      for (const token of BASE_TOKENS) {
        const addrLower = token.address.toLowerCase();
        const matching = detailedPairs.filter(
          (p) =>
            p.baseToken?.address?.toLowerCase() === addrLower ||
            p.quoteToken?.address?.toLowerCase() === addrLower,
        );
        if (matching.length > 0) {
          const best2 = matching.reduce<DetailedPair>((top, p) => {
            return (p.liquidity?.usd ?? 0) > (top.liquidity?.usd ?? 0) ? p : top;
          }, matching[0]);
          if (best2.priceUsd) {
            const price = parseFloat(best2.priceUsd);
            if (Number.isFinite(price)) priceMap.set(addrLower, price);
          }
        }
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
// 2. trendingTokens — boosted / trending tokens on Base via DexScreener
// ---------------------------------------------------------------------------

/**
 * Returns the current list of boosted / promoted tokens on Base from the
 * DexScreener token-boosts API.  Filters to Base-chain entries only and
 * caps the result at 15 tokens.
 *
 * Throws (preventing buyer charge) only when the upstream API is unavailable.
 * A successful response with zero Base entries is a valid (paid) answer.
 *
 * No params required — the trending list is global state.
 */
export async function trendingTokens(_params: Record<string, string>) {
  let raw: DexBoostToken[];

  try {
    const res = await fetch(
      "https://api.dexscreener.com/token-boosts/latest/v1",
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`DexScreener responded ${res.status}`);
    raw = (await res.json()) as DexBoostToken[];
  } catch (err) {
    // Hard throw — prevents the buyer from being charged for a failed lookup.
    throw new Error(
      `Trending data unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!Array.isArray(raw)) {
    throw new Error("Trending data unavailable: unexpected response format");
  }

  // Filter to Base chain and take the top 15 by boost amount.
  const baseTokens = raw
    .filter((t) => t.chainId === "base")
    .slice(0, 15)
    .map((t) => ({
      tokenAddress: t.tokenAddress ?? null,
      description: typeof t.description === "string"
        ? t.description.trim().slice(0, 140) || null
        : null,
      amount: t.totalAmount ?? t.amount ?? null,
      url: t.url ?? null,
    }));

  return {
    chain: "base",
    count: baseTokens.length,
    tokens: baseTokens,
    checkedAt: new Date().toISOString(),
  };
}
