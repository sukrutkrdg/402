/**
 * The marketplace catalog.
 *
 * Each entry is an x402-protected, pay-per-call API. The `handler` produces the
 * actual response a buyer receives *after* their payment settles. Everything is
 * self-contained (no external API keys) so the demo runs out of the box — but
 * each handler is a normal async function, so swapping in a real upstream API or
 * an LLM call is a one-line change.
 */

import { aiSummarize, aiExtract, aiTranslate } from "./ai";
import { tokenRisk, addressIntel } from "./onchain";
import { gasOracle, tokenPrice, txDecode, multiTokenPrice, pairInfo, tokenPools } from "./onchain-extra";
import { holderDistribution } from "./holders";
import { walletTokens, trendingTokens } from "./onchain-extra2";
import { registerAlert } from "./alerts";
import { contractAbi, decodeSelector, encodeSelector } from "./onchain-extra3";
import { basenameResolve, ensResolve } from "./basename";
import { sanctionsCheck, complianceCheck, sanctionsBatch } from "./compliance";
import { newTokens } from "./onchain-extra4";
import { aiTokenReport } from "./ai-report";
import { rugScore } from "./scores";
import { tokenMomentum, tokenInfo, chainStatus } from "./market";
import { nftFloor, walletPortfolio } from "./alchemy";
import { walletNetworth, walletSummary, walletActivity } from "./covalent";
import { aiWalletReport } from "./ai-report";

export interface ServiceParam {
  name: string;
  label: string;
  placeholder: string;
  required?: boolean;
  multiline?: boolean;
}

export interface ServiceDef {
  id: string;
  name: string;
  tagline: string;
  description: string;
  /** Human price string passed straight to x402 (USD → USDC on Base). */
  price: string;
  icon: string;
  category: string;
  params: ServiceParam[];
  handler: (params: Record<string, string>) => Promise<unknown>;
}

// ---- tiny deterministic helpers so demo output looks alive but stays cheap ----

function pick<T>(arr: T[], seed: number): T {
  return arr[Math.abs(seed) % arr.length];
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const QUOTES = [
  "In crypto, patience is a position.",
  "The chain doesn't lie; it just waits to be read.",
  "Decentralization is a verb, not a noun.",
  "Pay-per-call is the unit economics of the agent era.",
  "Attribution turns anonymous traffic into a growth engine.",
  "Settle small, settle often, settle onchain.",
];

const ASSETS: Record<string, number> = {
  BTC: 67000,
  ETH: 3500,
  SOL: 165,
  BASE: 1.0,
};

export const SERVICES: ServiceDef[] = [
  {
    id: "token-risk",
    name: "Token Risk Check",
    tagline: "Pre-trade safety score for any Base token",
    description:
      "Pass a token contract address and get a risk score + flags (ERC-20 conformance, ownership renounce, upgradeable proxy) computed live from Base. Built for trading bots and agents that vet tokens before buying.",
    price: "$0.02",
    icon: "🛡️",
    category: "Onchain",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token address", required: true }],
    handler: tokenRisk,
  },
  {
    id: "address-intel",
    name: "Address Intelligence",
    tagline: "Instant profile of any Base address",
    description:
      "EOA vs contract, ETH + USDC balance, transaction count and activity level — straight from Base RPC. Useful for counterparty and wallet checks.",
    price: "$0.01",
    icon: "🔎",
    category: "Onchain",
    params: [{ name: "address", label: "Address", placeholder: "0x… wallet or contract", required: true }],
    handler: addressIntel,
  },
  {
    id: "gas-oracle",
    name: "Gas Oracle",
    tagline: "Live Base gas estimates — slow / normal / fast",
    description:
      "Returns current Base gas fees (baseFee, maxPriorityFee) and three tiered suggestions (slow, normal, fast) in Gwei, derived live from the Base RPC. Built for agents that time or cost-estimate transactions.",
    price: "$0.005",
    icon: "⛽",
    category: "Onchain",
    params: [],
    handler: gasOracle,
  },
  {
    id: "token-price",
    name: "Token Price",
    tagline: "DEX price & liquidity for any Base token",
    description:
      "Pass a Base token contract address and get the current USD price, 24h change, liquidity, and volume from DexScreener (highest-liquidity pair auto-selected). No API key required.",
    price: "$0.01",
    icon: "💲",
    category: "Onchain",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token address", required: true }],
    handler: tokenPrice,
  },
  {
    id: "tx-decode",
    name: "TX Decode",
    tagline: "Structural decode of any Base transaction",
    description:
      "Provide a Base transaction hash and get a structured summary: from/to, ETH value, status, gas used, block, method selector, and nonce — straight from Base RPC.",
    price: "$0.01",
    icon: "🔍",
    category: "Onchain",
    params: [{ name: "hash", label: "Transaction hash", placeholder: "0x… (66 hex characters)", required: true }],
    handler: txDecode,
  },
  {
    id: "wallet-tokens",
    name: "Wallet Token Portfolio",
    tagline: "ETH + major Base token balances with USD values",
    description:
      "Returns native ETH plus WETH, USDC, USDbC, DAI, cbETH balances for any Base address, enriched with live USD values via DexScreener. Only non-zero holdings are returned.",
    price: "$0.01",
    icon: "💼",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: walletTokens,
  },
  {
    id: "trending-tokens",
    name: "Trending Tokens on Base",
    tagline: "Currently boosted/promoted Base tokens",
    description:
      "Fetches the DexScreener boosts feed filtered to Base — up to 15 trending tokens with address, description, boost amount, and link. Great for discovery bots.",
    price: "$0.005",
    icon: "🔥",
    category: "Onchain",
    params: [],
    handler: trendingTokens,
  },
  {
    id: "price-alert",
    name: "Token Price Alert",
    tagline: "Webhook when a Base token crosses your target",
    description:
      "Pay once to register a price-threshold alert on any Base token. Supply target price, direction (above/below), and an https webhook URL. A polling cron (daily by default; configurable to ~minutes) checks DexScreener and POSTs your webhook when it crosses. Expires after 30 days.",
    price: "$0.05",
    icon: "🔔",
    category: "Onchain",
    params: [
      { name: "token", label: "Token address", placeholder: "0x… token", required: true },
      { name: "threshold", label: "Price threshold (USD)", placeholder: "1.50", required: true },
      { name: "direction", label: "Direction (above/below)", placeholder: "above", required: true },
      { name: "webhook", label: "Webhook URL (https)", placeholder: "https://your-endpoint", required: true },
    ],
    handler: registerAlert,
  },
  {
    id: "contract-abi",
    name: "Contract ABI Lookup",
    tagline: "Is this Base contract verified? Get its ABI",
    description:
      "Checks Sourcify for a Base contract's verification status and returns its ABI as function/event name lists + item count (full or partial match). No API key required.",
    price: "$0.01",
    icon: "📄",
    category: "Onchain",
    params: [{ name: "address", label: "Contract address", placeholder: "0x… contract", required: true }],
    handler: contractAbi,
  },
  {
    id: "decode-selector",
    name: "4-Byte Selector Decoder",
    tagline: "Turn a function selector into readable signatures",
    description:
      "Resolves a 4-byte function selector (e.g. 0x70a08231) to candidate human-readable signatures via 4byte.directory. Accepts a bare selector or full calldata.",
    price: "$0.005",
    icon: "🧩",
    category: "Onchain",
    params: [{ name: "selector", label: "Function selector", placeholder: "0x70a08231", required: true }],
    handler: decodeSelector,
  },
  {
    id: "basename",
    name: "Basename Resolver",
    tagline: "Resolve names ↔ addresses on Base",
    description:
      "Forward + reverse Basename resolution read from the Base L2 Resolver: turn jesse.base.eth into an address, or an address into its primary Basename. No API key required.",
    price: "$0.005",
    icon: "🏷️",
    category: "Onchain",
    params: [{ name: "query", label: "Basename or address", placeholder: "jesse.base.eth or 0x…", required: true }],
    handler: basenameResolve,
  },
  {
    id: "token-pools",
    name: "Token Pools",
    tagline: "All DEX pools for a token, deepest first",
    description:
      "Lists every DEX pool for a Base token (pair address, DEX, quote symbol, price, liquidity, 24h volume), sorted by liquidity. Tells agents where — and how deep — a token can be traded.",
    price: "$0.01",
    icon: "🏊",
    category: "Markets",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: tokenPools,
  },
  {
    id: "ens-resolve",
    name: "ENS Resolver",
    tagline: "Resolve .eth names ↔ addresses (Ethereum)",
    description:
      "Forward + reverse ENS resolution on Ethereum mainnet: turn vitalik.eth into an address, or an address into its primary ENS name. Complements the Basename resolver for Base.",
    price: "$0.005",
    icon: "🔤",
    category: "Onchain",
    params: [{ name: "query", label: "ENS name or address", placeholder: "vitalik.eth or 0x…", required: true }],
    handler: ensResolve,
  },
  {
    id: "encode-selector",
    name: "Function Selector Encoder",
    tagline: "Function signature → 4-byte selector",
    description:
      "Computes the 4-byte selector for a function signature (e.g. transfer(address,uint256) → 0xa9059cbb). The inverse of the decoder — useful for agents building or matching calldata.",
    price: "$0.005",
    icon: "🔣",
    category: "Onchain",
    params: [{ name: "signature", label: "Function signature", placeholder: "transfer(address,uint256)", required: true }],
    handler: encodeSelector,
  },
  {
    id: "sanctions",
    name: "Sanctions Check",
    tagline: "Is this address OFAC-sanctioned?",
    description:
      "Checks an address against the OFAC SDN list of sanctioned digital-currency addresses. Built for compliance agents and bots that must screen counterparties before transacting. Direct-address match; list refreshed regularly. No API key required.",
    price: "$0.01",
    icon: "⚖️",
    category: "Onchain",
    params: [{ name: "address", label: "Address to screen", placeholder: "0x… wallet or contract", required: true }],
    handler: sanctionsCheck,
  },
  {
    id: "holders",
    name: "Token Holder Distribution",
    tagline: "Top holders, concentration & LP lock",
    description:
      "Top-10 holders with their %, holder count, concentration level (whale risk), and LP-lock %, from GoPlus. Lets agents judge how fairly a token is distributed before trading. No API key required.",
    price: "$0.01",
    icon: "👥",
    category: "Onchain",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: holderDistribution,
  },
  {
    id: "multi-price",
    name: "Batch Token Prices",
    tagline: "Prices for up to 10 Base tokens at once",
    description:
      "Pass a comma-separated list of up to 10 Base token addresses and get USD price + 24h change for each in one call. Ideal for agents pricing a portfolio or watchlist.",
    price: "$0.01",
    icon: "🧾",
    category: "Onchain",
    params: [{ name: "addresses", label: "Token addresses (comma-separated)", placeholder: "0x…, 0x…", required: true }],
    handler: multiTokenPrice,
  },
  {
    id: "compliance-check",
    name: "Compliance Check",
    tagline: "OFAC + profile + risk → one verdict",
    description:
      "Combined counterparty screening for an address: direct OFAC sanctions match, EOA/contract profile, and (for contracts) risk flags — rolled into a single recommendation (blocked / review / clear). Built for compliance agents.",
    price: "$0.02",
    icon: "🧾",
    category: "Onchain",
    params: [{ name: "address", label: "Address to screen", placeholder: "0x… wallet or contract", required: true }],
    handler: complianceCheck,
  },
  {
    id: "sanctions-batch",
    name: "Batch Sanctions Screening",
    tagline: "Screen up to 25 addresses against OFAC at once",
    description:
      "Pass a comma-separated list of up to 25 addresses and get an OFAC sanctions result for each, plus the flagged subset. Built for compliance agents vetting whole counterparty lists in one call.",
    price: "$0.02",
    icon: "⚖️",
    category: "Onchain",
    params: [{ name: "addresses", label: "Addresses (comma-separated)", placeholder: "0x…, 0x…", required: true }],
    handler: sanctionsBatch,
  },
  {
    id: "pair-info",
    name: "DEX Pair Info",
    tagline: "Pool price, liquidity, volume & buy/sell counts",
    description:
      "Given a Base DEX pair (pool) address, returns price, liquidity, 24h volume, buy/sell transaction counts and FDV from DexScreener. For agents analysing a specific pool's depth and activity.",
    price: "$0.01",
    icon: "💧",
    category: "Markets",
    params: [{ name: "pair", label: "Pair (pool) address", placeholder: "0x… pair", required: true }],
    handler: pairInfo,
  },
  {
    id: "rug-score",
    name: "Rug Probability Score",
    tagline: "One 0-100 risk gate (security + holders + liquidity)",
    description:
      "Deterministic 0-100 rug-probability score combining security flags, holder concentration, LP lock and liquidity depth — with the exact signals that drove it. A fast numeric gate for trading agents. Higher = riskier.",
    price: "$0.01",
    icon: "📉",
    category: "Onchain",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: rugScore,
  },
  {
    id: "token-momentum",
    name: "Token Momentum",
    tagline: "Price & volume trend across 1h / 6h / 24h",
    description:
      "Price change and trading volume across 1h, 6h and 24h windows for a Base token, plus a trend read (strong_up → strong_down). Lets agents gauge momentum, not just a single 24h number.",
    price: "$0.01",
    icon: "📊",
    category: "Markets",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: tokenMomentum,
  },
  {
    id: "token-info",
    name: "Token Info & Socials",
    tagline: "Name, logo, website & socials for a token",
    description:
      "Metadata for a Base token: name, symbol, logo image, official website and social links (X/Telegram/etc.) plus price & liquidity — from DexScreener. For agents and UIs enriching a token.",
    price: "$0.005",
    icon: "🪪",
    category: "Data",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: tokenInfo,
  },
  {
    id: "chain-status",
    name: "Base Chain Status",
    tagline: "Block, base fee, ETH price & transfer cost in USD",
    description:
      "Live Base chain snapshot: latest block, base fee + priority fee (Gwei), current ETH price, and the estimated USD cost of a simple ETH transfer. For agents timing or budgeting transactions.",
    price: "$0.005",
    icon: "⛓️",
    category: "Onchain",
    params: [],
    handler: chainStatus,
  },
  {
    id: "new-tokens",
    name: "New Token Scanner",
    tagline: "Freshly listed/profiled tokens on Base",
    description:
      "Returns the latest tokens profiled on Base from the DexScreener feed — address, description, and links. Great for discovery bots hunting new launches early.",
    price: "$0.005",
    icon: "🆕",
    category: "Onchain",
    params: [],
    handler: newTokens,
  },
  {
    id: "nft-floor",
    name: "NFT Floor Price",
    tagline: "Live floor price for a Base NFT collection",
    description:
      "Current floor price for a Base NFT collection (OpenSea / LooksRare) via Alchemy. Pass the collection contract address. Coverage is limited to marketplace-listed collections. For agents tracking NFT markets.",
    price: "$0.01",
    icon: "🖼️",
    category: "Markets",
    params: [{ name: "contract", label: "Collection contract address", placeholder: "0x… collection", required: true }],
    handler: nftFloor,
  },
  {
    id: "wallet-portfolio",
    name: "Full Wallet Portfolio",
    tagline: "All ERC-20 holdings of a wallet with USD value",
    description:
      "Complete ERC-20 portfolio for a Base address — every non-zero token with balance, metadata and live USD value, plus a total. Powered by Alchemy (beyond the curated wallet-tokens list).",
    price: "$0.01",
    icon: "💰",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: walletPortfolio,
  },
  {
    id: "wallet-networth",
    name: "Wallet Net Worth",
    tagline: "All tokens + USD value (reliable pricing)",
    description:
      "Complete ERC-20 portfolio for a Base address with accurate USD values from Covalent (handles stablecoins & long-tail tokens). Spam-filtered, sorted by value, with a total. The reliable portfolio endpoint.",
    price: "$0.01",
    icon: "🏦",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: walletNetworth,
  },
  {
    id: "wallet-summary",
    name: "Wallet Age & Activity",
    tagline: "Tx count, first/last activity, wallet age",
    description:
      "Total transaction count, first & last activity timestamps, and wallet age in days for any Base address. Built for sybil/rug screening and counterparty trust checks.",
    price: "$0.01",
    icon: "🕰️",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: walletSummary,
  },
  {
    id: "wallet-activity",
    name: "Wallet Activity",
    tagline: "Recent transactions for an address",
    description:
      "The latest transactions for a Base address — hash, time, from/to, ETH value, success — via Covalent. For agents tracking what a wallet is doing.",
    price: "$0.01",
    icon: "📜",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: walletActivity,
  },
  {
    id: "ai-wallet-report",
    name: "AI Wallet Report",
    tagline: "Claude-written verdict on any wallet",
    description:
      "The flagship wallet report: aggregates net worth, age/activity and recent transactions, then Claude synthesizes a verdict (e.g. fresh/risky → established/active) with key observations. One call, agent-ready wallet intelligence.",
    price: "$0.03",
    icon: "🧠",
    category: "AI",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: aiWalletReport,
  },
  {
    id: "ai-token-report",
    name: "AI Token Report",
    tagline: "Claude-written due-diligence verdict for a Base token",
    description:
      "The flagship report: aggregates token risk, holder concentration, price/liquidity and OFAC sanctions, then Claude synthesizes a structured verdict (avoid → favorable) with key risks and positives. One call, agent-ready intelligence you can't get free.",
    price: "$0.03",
    icon: "🔬",
    category: "AI",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: aiTokenReport,
  },
  {
    id: "ai-summarize",
    name: "AI Summarize",
    tagline: "Any text → crisp bullet points",
    description:
      "Paste text and get a 3-5 bullet summary from Claude. Pay-per-call — no API key or subscription needed on your side.",
    price: "$0.02",
    icon: "🧠",
    category: "AI",
    params: [{ name: "text", label: "Text to summarize", placeholder: "Paste an article, email, or notes…", required: true, multiline: true }],
    handler: aiSummarize,
  },
  {
    id: "ai-extract",
    name: "AI Extract",
    tagline: "Unstructured text → structured JSON",
    description:
      "Pull named fields out of any text as clean JSON (e.g. name, email, company, date). Powered by Claude structured outputs.",
    price: "$0.02",
    icon: "🗂️",
    category: "AI",
    params: [
      { name: "text", label: "Source text", placeholder: "Paste text containing the data…", required: true, multiline: true },
      { name: "fields", label: "Fields (comma-separated)", placeholder: "name, email, company, date" },
    ],
    handler: aiExtract,
  },
  {
    id: "ai-translate",
    name: "AI Translate",
    tagline: "Translate text to any language",
    description: "Translate text into a target language with Claude. One micro-payment per translation.",
    price: "$0.02",
    icon: "🌐",
    category: "AI",
    params: [
      { name: "text", label: "Text to translate", placeholder: "Merhaba dünya…", required: true, multiline: true },
      { name: "to", label: "Target language", placeholder: "English" },
    ],
    handler: aiTranslate,
  },
  {
    id: "market-snapshot",
    name: "Market Snapshot (demo)",
    tagline: "DEMO — synthetic price board, not live data",
    description:
      "DEMO/synthetic endpoint: returns deterministic pseudo-prices for top assets to test the x402 wire format. NOT live market data — use token-price / token-momentum for real prices.",
    price: "$0.001",
    icon: "📈",
    category: "Demo",
    params: [],
    handler: async () => {
      const now = Date.now();
      const assets = Object.entries(ASSETS).map(([symbol, base]) => {
        const drift = ((hash(symbol + Math.floor(now / 60000)) % 800) - 400) / 10000;
        const price = +(base * (1 + drift)).toFixed(base < 10 ? 4 : 2);
        return { symbol, price, change24h: +(drift * 100).toFixed(2) };
      });
      return { asOf: new Date(now).toISOString(), currency: "USD", assets };
    },
  },
  {
    id: "weather",
    name: "Weather Oracle (demo)",
    tagline: "DEMO — synthetic weather, not real data",
    description:
      "DEMO/synthetic endpoint mirroring the canonical x402 `/weather` example for wire-format testing. Output is deterministic from the city name — NOT real weather.",
    price: "$0.001",
    icon: "🌦️",
    category: "Demo",
    params: [{ name: "city", label: "City", placeholder: "Istanbul", required: true }],
    handler: async (p) => {
      const city = (p.city || "Istanbul").slice(0, 40);
      const seed = hash(city.toLowerCase());
      const conditions = ["Clear", "Cloudy", "Rain", "Windy", "Snow", "Fog"];
      return {
        city,
        condition: pick(conditions, seed),
        tempC: 8 + (seed % 25),
        humidity: 40 + (seed % 55),
        windKph: 3 + (seed % 30),
        asOf: new Date().toISOString(),
      };
    },
  },
  {
    id: "quote",
    name: "Alpha Quote (demo)",
    tagline: "DEMO — rotating quote, for wiring tests",
    description: "DEMO endpoint: a rotating quote. The cheapest possible paid call — perfect for testing your x402 wiring.",
    price: "$0.001",
    icon: "💬",
    category: "Demo",
    params: [],
    handler: async () => {
      const seed = hash(String(Math.floor(Date.now() / 30000)));
      return { quote: pick(QUOTES, seed), at: new Date().toISOString() };
    },
  },
  {
    id: "secure-token",
    name: "Secure Token",
    tagline: "Cryptographically strong random IDs",
    description:
      "Generate N url-safe random tokens server-side. Demonstrates a paid utility endpoint with a query parameter.",
    price: "$0.002",
    icon: "🔐",
    category: "Utility",
    params: [{ name: "count", label: "How many", placeholder: "3" }],
    handler: async (p) => {
      const count = Math.min(Math.max(parseInt(p.count || "1", 10) || 1, 1), 10);
      const tokens = Array.from({ length: count }, () => {
        const bytes = new Uint8Array(18);
        crypto.getRandomValues(bytes);
        return Buffer.from(bytes).toString("base64url");
      });
      return { count, tokens, generatedAt: new Date().toISOString() };
    },
  },
];

export function getService(id: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === id);
}
