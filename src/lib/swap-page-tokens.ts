/**
 * What the /swap page offers. The page's free quote routes accept only these,
 * so they serve the page and are not a free copy of the paid base-swap and
 * near-swap endpoints (which take any token).
 */
export const BASE_PAGE_TOKENS = ["USDC", "ETH", "WETH", "cbBTC", "AERO", "DAI", "EURC", "cbETH"] as const;

export const NEAR_PAGE_ASSETS = [
  { v: "USDC", label: "USDC · NEAR" },
  { v: "USDT", label: "USDT · NEAR" },
  { v: "NEAR", label: "NEAR" },
  { v: "USDC@base", label: "USDC · Base" },
  { v: "ETH@base", label: "ETH · Base" },
  { v: "ETH@eth", label: "ETH · Ethereum" },
  { v: "USDC@eth", label: "USDC · Ethereum" },
  { v: "USDC@arb", label: "USDC · Arbitrum" },
  { v: "BTC@btc", label: "BTC · Bitcoin" },
  { v: "SOL@sol", label: "SOL · Solana" },
  { v: "USDC@sol", label: "USDC · Solana" },
] as const;

const lower = (xs: readonly string[]) => new Set(xs.map((x) => x.toLowerCase()));
const BASE_SET = lower(BASE_PAGE_TOKENS);
const NEAR_SET = lower(NEAR_PAGE_ASSETS.map((a) => a.v));

export const onBasePage = (t: string | null | undefined) => BASE_SET.has((t || "").trim().toLowerCase());
export const onNearPage = (t: string | null | undefined) => NEAR_SET.has((t || "").trim().toLowerCase());

/** Quotes the free page routes hand out per day in total, across all callers. */
export const PAGE_QUOTES_PER_DAY = 2000;
