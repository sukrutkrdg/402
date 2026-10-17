/**
 * Market intelligence, DEX liquidity, perp funding, and price discovery services
 */

import type { ServiceDef } from "./types";
import { perpFunding } from "../perp-funding";
import { fundingRadar } from "../funding-radar";
import { tokenizedStockPrice } from "../tokenized-stock-price";
import { stockFairValue } from "../stock-fair-value";
import { marketPulse } from "../market-pulse";
import { multiChainGas } from "../multi-chain-gas";
import { exitLiquidity } from "../liquidity";
import { stablecoinPeg } from "../stablecoin-peg";
import { corporateActions } from "../corporate-actions";
import { rwaDividendFeed } from "../rwa-dividend-feed";
import { swapRoute } from "../swap-route";
import { volumeCheck } from "../volume-check";
import { pairInfo, tokenPools } from "../onchain-extra";
import { dexSpread } from "../dex-spread";
import { tokenInfo, tokenMomentum } from "../market";
import { nftFloor } from "../alchemy";
import { defiTvl, stablecoinMcap } from "../commodity-data";
import { cryptoGlobal, cryptoMarkets } from "../crypto-markets";
import { cryptoTrending, fearGreed } from "../market-sentiment";
import { polymarketOdds } from "../polymarket";

export const MARKETS_SERVICES: ServiceDef[] = [
  {
      id: "perp-funding",
      name: "Perp Funding & Basis",
      tagline: "The futures side of a trade — funding, OI, basis, crowding",
      description:
        "Choosing between spot and a perp? This is the data that choice needs. Aggregate OI-weighted perpetual funding, open interest and basis for a coin across venues (CoinGecko, no key): who pays whom (longs crowded vs shorts crowded), the carry you earn or bleed holding the perp, and contango vs backwardation. Verdict neutral / elevated / extreme. Pass symbol=BTC. Funding annualised as an estimate (8h intervals assumed). A market-structure signal, not a price call. Not financial advice.",
      price: "$0.04",
      icon: "📑",
      category: "Markets",
      params: [{ name: "symbol", label: "Coin symbol (BTC, ETH, SOL…)", placeholder: "BTC", required: true }],
      handler: perpFunding,
    },
  {
      id: "funding-radar",
      name: "Funding Radar (Crowding)",
      tagline: "Where's the crowd? Most crowded longs & shorts by funding",
      description:
        "Scans the whole perpetual market and ranks the most crowded longs and shorts by funding, so an agent finds squeeze / mean-reversion setups in one call. Extreme positive funding = crowded long (long-squeeze risk on a dip); extreme negative = crowded short (short-squeeze fuel on a pump). Returns the market tilt plus the top coins at each edge, OI-weighted over a liquidity floor. CoinGecko, no key. A setup radar, not an entry signal. Not financial advice.",
      price: "$0.05",
      icon: "🛰️",
      category: "Markets",
      params: [
        { name: "limit", label: "Top N per side (default 8, max 15)", placeholder: "8" },
        { name: "minOi", label: "Min open interest USD (default 25M)", placeholder: "25000000" },
      ],
      handler: fundingRadar,
    },
  {
      id: "tokenized-stock-price",
      name: "Tokenized Stock Price (onchain)",
      tagline: "Live Base price & liquidity of Coinbase's tokenized stocks",
      description:
        "b20-safety says a tokenized stock is a real issuance; this says what it trades at ON-CHAIN and whether there's liquidity for size. Pass symbol=AAPL (or AAPLc) for the deepest Base pool's price, aggregate liquidity, 24h move and volume; omit symbol for the full directory. Covers every stock Coinbase lists — the roster tops itself up from Coinbase's own API. This is the tradeable Base price, which can diverge from NYSE NAV. Not financial advice.",
      price: "$0.03",
      icon: "🏦",
      category: "Markets",
      params: [{ name: "symbol", label: "Ticker (AAPL, TSLA, NVDA… or AAPLc). Omit for the list", placeholder: "AAPL" }],
      handler: tokenizedStockPrice,
    },
  {
      id: "stock-fair-value",
      name: "Tokenized Stock Fair Value",
      tagline: "Is the Base price of AAPLc, NVDAc… fair right now — and is the reference frozen?",
      description:
        "Tokenized stocks trade 24/7 on Base; their reference price (Chainlink, used by Aave and Morpho) freezes when the US market shuts. One call: the US session, the reference and its age, the DEX premium/discount in bps against it, pool depth and rough impact for amountUsd, paused features and any announced dividend. Covers every stock Coinbase lists. Not financial advice.",
      price: "$0.02",
      icon: "⚖️",
      category: "Markets",
      params: [
        { name: "symbol", label: "Stock (NVDA, NVDAc or token address)", placeholder: "NVDA" },
        { name: "amountUsd", label: "Trade size in USD (optional)", placeholder: "1000" },
      ],
      handler: stockFairValue,
    },
  {
      id: "market-pulse",
      name: "Market Pulse (trading-grade)",
      tagline: "Mood + attention + leverage, in one read",
      description:
        "One trading-grade read where the single Fear & Greed number isn't enough. Combines three independent angles: mood (Fear & Greed), attention (what's trending), and leverage (OI-weighted perp funding tilt market-wide). The edge is the combination — greed + crowded longs = froth/long-squeeze risk; fear + crowded shorts = capitulation/short-squeeze setup. Returns a stance (frothy / capitulation_setup / risk_on / risk_off / neutral). One call, no key. A gauge, not a signal. Not financial advice.",
      price: "$0.03",
      icon: "🌡️",
      category: "Markets",
      params: [],
      handler: marketPulse,
    },
  {
      id: "multi-chain-gas",
      name: "Multi-Chain Gas Compare",
      tagline: "Which chain is cheapest to operate on right now",
      description:
        "Reads the live gas price on each major EVM chain an agent uses (base, arbitrum, optimism, ethereum, polygon) and turns it into the USD cost of the actions that matter — a plain transfer and a DEX swap — using live native-token prices. Returns one ranked answer with the cheapest chain, so an agent deciding where to settle doesn't make five RPC calls. A chain it could not read is 'unknown' and excluded from the pick, never guessed. Gas units are typical estimates. Not financial advice.",
      price: "$0.01",
      icon: "⛽",
      category: "Markets",
      params: [],
      handler: multiChainGas,
    },
  {
      id: "exit-liquidity",
      name: "Exit Liquidity Check",
      tagline: "Can you actually get OUT of this position?",
      description:
        "Give a Base token + a trade size in USD → estimated buy AND sell price impact, whether you can unwind that size without collapsing the pool, and the largest safe exit. The hidden form of a rug isn't 'you can't buy' — it's 'you can't sell'. Built for trading agents sizing positions.",
      price: "$0.02",
      icon: "🚪",
      category: "Markets",
      params: [
        { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
        { name: "size", label: "Trade size in USD", placeholder: "1000" },
      ],
      handler: exitLiquidity,
    },
  {
      id: "stablecoin-peg",
      name: "Stablecoin Peg Monitor",
      tagline: "Are the dollars you're holding still worth a dollar?",
      description:
        "Live DEX price vs the $1.00 peg for major USD-pegged stablecoins on Base (USDC, USDT, DAI, USDbC). A depeg is silent — balanceOf doesn't change, only what it's worth does — so an agent parked in stables reprices everything off a stale $1. Reports per-coin deviation in basis points and a healthy/watch/depeg status, worst-case across the set. A feed outage reads as 'unknown', never a healthy peg. Pass symbol= for one coin. Not financial advice.",
      price: "$0.01",
      icon: "⚖️",
      category: "Markets",
      params: [
        { name: "symbol", label: "One stablecoin (optional, default all)", placeholder: "USDC" },
      ],
      handler: stablecoinPeg,
    },
  {
      id: "corporate-actions",
      name: "Tokenized Stock Corporate Actions",
      tagline: "Announced dividends and splits on Base's tokenized stocks, before they land",
      description:
        "Dividends and splits on a tokenized stock settle by moving its multiplier; balanceOf never changes, so a naive reader is silently wrong. Coinbase announces each one on chain days ahead. This lists every announced action across all tokenized stocks Coinbase lists, plus any ERC-8056 schedule, and with wallet= which touch that wallet's holdings. Lenders pause a stock's reserve while one is applied. Not financial advice.",
      price: "$0.03",
      icon: "📅",
      category: "Markets",
      params: [
        { name: "wallet", label: "Wallet to intersect with holdings (optional)", placeholder: "0x…" },
      ],
      handler: corporateActions,
    },
  {
      id: "rwa-dividend-feed",
      name: "Tokenized Stock Action Feed",
      tagline: "Dividends paid, dividends announced, and accrual to date on Base's tokenized stocks",
      description:
        "Every dividend or split applied to a Coinbase tokenized stock on Base, with multiplier before/after and the share accrual, joined to Coinbase's own record; those announced but not yet applied; and each stock's cumulative accrual. The record cost-basis and NAV need. symbol= narrows to one stock. A failed warehouse read reads as degraded, never 'none'. Not financial advice.",
      price: "$0.03",
      icon: "🗞️",
      category: "Markets",
      params: [
        { name: "symbol", label: "Stock (optional, e.g. NVDA)", placeholder: "NVDA" },
        { name: "limit", label: "Max past events (optional, default 50)", placeholder: "50" },
      ],
      handler: rwaDividendFeed,
    },
  {
      id: "swap-route",
      name: "Swap Route + Safety",
      tagline: "Where to trade it, the impact, and whether it's safe to receive",
      description:
        "Give a token and a trade size in USD → the deepest Base pool to route through, estimated price impact, a suggested slippage tolerance + minimum-out, all gated on a honeypot/sell-tax check of the token you'd receive (no point routing into something you can't sell). Moves an agent from analysis to action in one call.",
      price: "$0.03",
      icon: "🧭",
      category: "Markets",
      params: [
        { name: "tokenOut", label: "Token to receive", placeholder: "0x… token", required: true },
        { name: "amountUsd", label: "Trade size in USD", placeholder: "1000" },
      ],
      handler: swapRoute,
      noFreeTier: true,
    },
  {
      id: "volume-check",
      name: "Volume Authenticity Check",
      tagline: "Is this trading volume real — or painted on by bots?",
      description:
        "Reads the deepest pool's 24h volume, buy/sell counts, liquidity and price move, and scores how organic the activity looks. Volume 10x+ the pool's liquidity, near-perfect buy/sell symmetry, or big volume that moves the price nowhere are the classic wash-trading signatures used to bait buyers. Returns a 0-100 suspicion score and verdict.",
      price: "$0.02",
      icon: "🎭",
      category: "Markets",
      params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
      handler: volumeCheck,
    },
  {
      id: "token-pools",
      name: "Token Pools",
      tagline: "All DEX pools for a token, deepest first",
      description:
        "Lists every DEX pool for a Base token (pair address, DEX, quote symbol, price, liquidity, 24h volume), sorted by liquidity. Tells agents where — and how deep — a token can be traded.",
      price: "$0.02",
      icon: "🏊",
      category: "Markets",
      params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
      handler: tokenPools,
    },
  {
      id: "dex-spread",
      name: "DEX Price Spread",
      tagline: "Is this token's price consistent across DEXes — arb window or manipulation?",
      description:
        "A token on several Base DEXes should cost about the same on each; a gap is either an arbitrage window or, on a thin pool, a mispricing that signals wash/manipulation. Compares the price across the LIQUID venues (over a floor, default $5k): tight (trustworthy), arb_window, wide (likely mispricing), or single_venue (one pool, as manipulable as it is thin). Separates real arbitrage from thin-pool noise. Snapshots — confirm with a live quote. Not financial advice.",
      price: "$0.02",
      icon: "⚖️",
      category: "Markets",
      params: [
        { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
        { name: "minLiquidityUsd", label: "Liquidity floor per venue (optional, default 5000)", placeholder: "5000" },
      ],
      handler: dexSpread,
    },
  {
      id: "pair-info",
      name: "DEX Pair Info",
      tagline: "Pool price, liquidity, volume & buy/sell counts",
      description:
        "Given a Base DEX pair (pool) address, returns price, liquidity, 24h volume, buy/sell transaction counts and FDV from DexScreener. For agents analysing a specific pool's depth and activity.",
      price: "$0.02",
      icon: "💧",
      category: "Markets",
      params: [{ name: "pair", label: "Pair (pool) address", placeholder: "0x… pair", required: true }],
      handler: pairInfo,
      noFreeTier: true,
    },
  {
      id: "token-momentum",
      name: "Token Momentum",
      tagline: "Price & volume trend across 1h / 6h / 24h",
      description:
        "Price change and trading volume across 1h, 6h and 24h windows for a Base token, plus a trend read (strong_up → strong_down). Lets agents gauge momentum, not just a single 24h number.",
      price: "$0.02",
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
      price: "$0.01",
      icon: "🪪",
      category: "Markets",
      params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
      handler: tokenInfo,
    },
  {
      id: "nft-floor",
      name: "NFT Floor Price",
      tagline: "Live floor price for a Base NFT collection",
      description:
        "Current floor price for a Base NFT collection (OpenSea / LooksRare) via Alchemy. Pass the collection contract address. Coverage is limited to marketplace-listed collections. For agents tracking NFT markets.",
      price: "$0.02",
      icon: "🖼️",
      category: "Markets",
      params: [{ name: "contract", label: "Collection contract address", placeholder: "0x… collection", required: true }],
      handler: nftFloor,
      noFreeTier: true,
    },
  {
      id: "defi-tvl",
      name: "DeFi TVL Rankings",
      tagline: "Top DeFi protocols by TVL, filterable by chain & category",
      description:
        "Top DeFi protocols ranked by total value locked (DefiLlama), with 1d/7d change — CEX/Chain/Bridge excluded so this is real DeFi. Pass chain= (e.g. base) to filter to protocols active on it, category= (e.g. Lending, Dexes) to narrow, limit= up to 50. tvlUsd is the protocol's GLOBAL TVL; chain filters presence, not per-chain TVL. The DeFi-rankings commodity, served cheap. Not financial advice.",
      price: "$0.01",
      icon: "🏦",
      category: "Markets",
      params: [
        { name: "chain", label: "Filter by chain (optional)", placeholder: "base" },
        { name: "category", label: "Filter by category (optional)", placeholder: "Lending" },
        { name: "limit", label: "How many (default 10, max 50)", placeholder: "10" },
      ],
      handler: defiTvl,
    },
  {
      id: "stablecoin-mcap",
      name: "Stablecoin Market Cap",
      tagline: "Total stablecoin market cap + the largest by circulating supply",
      description:
        "Total stablecoin market capitalisation and the largest stablecoins by circulating supply across all chains (DefiLlama), with peg type/mechanism and live price — plus a depeg watch flagging any USD-pegged coin 2%+ off a dollar. The stablecoin-market commodity agents track; for a single Base-stablecoin peg check use stablecoin-peg. Not financial advice.",
      price: "$0.01",
      icon: "💵",
      category: "Markets",
      params: [{ name: "limit", label: "How many top coins (default 10, max 30)", placeholder: "10" }],
      handler: stablecoinMcap,
    },
  {
      id: "crypto-markets",
      name: "Crypto Market Data",
      tagline: "Top assets by market cap — live price, mcap, 24h, volume",
      description:
        "Live cross-asset market data: the top coins ranked by market cap with price, market cap, 24h change and volume (CoinGecko). The global snapshot an agent reads before trading — our other price tools are Base-token-address based; this is the whole market. Pass limit= (up to 100) and vs= (usd/eur/…). Not financial advice.",
      price: "$0.01",
      icon: "📊",
      category: "Markets",
      params: [
        { name: "limit", label: "How many coins (default 20, max 100)", placeholder: "20" },
        { name: "vs", label: "Quote currency (default usd)", placeholder: "usd" },
      ],
      handler: cryptoMarkets,
    },
  {
      id: "crypto-global",
      name: "Crypto Market Overview",
      tagline: "Total market cap, BTC/ETH dominance, 24h move — one call",
      description:
        "A one-call read of the whole crypto market (CoinGecko): total market capitalisation, 24h volume, the 24h market-cap move, BTC and ETH dominance, and the active-coin count. The macro context an agent uses to size risk before acting. Not financial advice.",
      price: "$0.01",
      icon: "🌍",
      category: "Markets",
      params: [],
      handler: cryptoGlobal,
    },
  {
      id: "fear-greed",
      name: "Crypto Fear & Greed",
      tagline: "The market-mood gauge every trading agent checks (0–100)",
      description:
        "The crypto Fear & Greed Index (alternative.me): 0 = extreme fear, 100 = extreme greed, from volatility, momentum, volume, social and dominance — plus the day-over-day change and recent history. The one-number market-mood read an agent uses to size risk. Pass days= for history (up to 30). A sentiment gauge, not a signal. Not financial advice.",
      price: "$0.002",
      icon: "😱",
      category: "Markets",
      params: [{ name: "days", label: "History days (default 1, max 30)", placeholder: "7" }],
      handler: fearGreed,
    },
  {
      id: "crypto-trending",
      name: "Trending Coins",
      tagline: "What the market is watching right now — global attention feed",
      description:
        "The coins most searched on CoinGecko right now, ranked, with market-cap rank, price and 24h change. A global attention/discovery feed for agents hunting what's moving — distinct from trending-tokens, which is Base-DEX specific. An attention signal, not quality or safety: vet anything here with token-risk before touching it. Not financial advice.",
      price: "$0.01",
      icon: "🔥",
      category: "Markets",
      params: [],
      handler: cryptoTrending,
    },
  {
      id: "polymarket-odds",
      name: "Polymarket Odds & Probability",
      tagline: "Event prediction probabilities & consensus odds from Polymarket",
      description:
        "🆕 Queries Polymarket's Gamma CLOB for active prediction markets. Resolves event outcome probabilities (Yes/No %), 24h volume, liquidity, and resolution date in one call. Designed for AI agents that need a real-world reality check before trading, hedging, or rebalancing treasury. Pass query= (e.g. 'fed', 'btc', 'kraken-ipo-in-2025'). A probabilistic signal, not financial advice.",
      price: "$0.02",
      icon: "🔮",
      category: "Markets",
      params: [{ name: "query", label: "Market topic, question or slug", placeholder: "fed", required: true }],
      handler: polymarketOdds,
    },
];
