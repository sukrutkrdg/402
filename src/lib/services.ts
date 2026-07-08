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
import { aiTokenReport, aiMarketBrief } from "./ai-report";
import { rugScore } from "./scores";
import { tokenMomentum, tokenInfo, chainStatus } from "./market";
import { nftFloor, walletPortfolio } from "./alchemy";
import { walletNetworth, walletSummary, walletActivity, tokenApprovals, historicalPrice, walletNfts, tokenTransfers } from "./covalent";
import { aiWalletReport, aiWalletSecurity, aiTxExplain, aiContractRisk, aiDeepDueDiligence } from "./ai-report";
import { batchRisk } from "./batch";
import { simulateTx } from "./tx-sim";
import { exitLiquidity } from "./liquidity";
import { sellability } from "./sellability";
import { holderForensics } from "./holder-forensics";
import { proxyCheck } from "./proxy";
import { approvalAdvisor } from "./approval-advisor";
import { portfolioScan } from "./portfolio-scan";
import { registerRugMonitor } from "./rug-monitor";
import { contractDanger } from "./contract-danger";
import { lpLock } from "./lp-lock";
import { deployerReputation } from "./deployer-rep";
import { preSignPreflight } from "./pre-sign";
import { swapRoute } from "./swap-route";
import { tokenUnlock } from "./token-unlock";
import { volumeCheck } from "./volume-check";
import { positionHealth } from "./position-health";
import { tokenCompare } from "./token-compare";
import { revokeBuilder } from "./revoke-builder";

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
  /**
   * Exclude from the free tier — payment always required. Set on services backed
   * by a metered/paid upstream (e.g. Covalent) so free calls can't drain credits
   * for zero revenue. AI services are already paid-only via their category.
   */
  noFreeTier?: boolean;
}

export const SERVICES: ServiceDef[] = [
  {
    id: "token-risk",
    name: "Token Risk Check",
    tagline: "Pre-trade safety score for any Base token",
    description:
      "Pass a token contract address and get a risk score + flags (ERC-20 conformance, ownership renounce, upgradeable proxy) computed live from Base. Built for trading bots and agents that vet tokens before buying.",
    price: "$0.03",
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
    price: "$0.02",
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
    price: "$0.01",
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
    price: "$0.02",
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
    price: "$0.02",
    icon: "🔍",
    category: "Onchain",
    params: [{ name: "hash", label: "Transaction hash", placeholder: "0x… (66 hex characters)", required: true }],
    handler: txDecode,
  },
  {
    id: "simulate-tx",
    name: "Transaction Simulation",
    tagline: "What an unsigned tx will do — before you sign it",
    description:
      "Simulate an UNSIGNED transaction against current Base state: what tokens leave/arrive for the sender, any approvals it grants (flags unlimited allowance & setApprovalForAll — the classic drain vector), whether it would revert, and gas. The pre-execution safety check every agent needs before signing.",
    price: "$0.03",
    icon: "🧪",
    category: "Onchain",
    params: [
      { name: "from", label: "Sender address", placeholder: "0x… sender", required: true },
      { name: "to", label: "To (recipient/contract)", placeholder: "0x… recipient or contract", required: true },
      { name: "data", label: "Calldata (hex, optional)", placeholder: "0x… (for contract calls)" },
      { name: "value", label: "ETH value (optional)", placeholder: "0.1" },
    ],
    handler: simulateTx,
    noFreeTier: true,
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
    id: "sellability",
    name: "Sellability Check",
    tagline: "Can you actually SELL it — or is it a honeypot?",
    description:
      "The hard honeypot question, answered three ways: security simulation (honeypot, cannot-sell-all, sell/buy tax, transfer-pausable), a LIVE transfer simulation we run ourselves from a real holder (reverts/taxed?), and exit liquidity. Returns a hard canSell verdict with reasons. Selling is where rugs hide — check before you buy.",
    price: "$0.05",
    icon: "🔒",
    category: "Onchain",
    params: [
      { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
      { name: "size", label: "Position size USD (exit check)", placeholder: "5000" },
    ],
    handler: sellability,
    noFreeTier: true,
  },
  {
    id: "holder-forensics",
    name: "Holder Forensics",
    tagline: "Benign vs dangerous concentration — who can dump",
    description:
      "Goes past 'top-10 = X%' to classify the holder base: how much the creator & owner still hold, which top holders are infrastructure (LP/CEX/bridge — benign) vs unlabelled wallets (the concentration that can actually dump the price), and the largest non-infra wallet. Separating benign from dangerous concentration is the analysis others skip.",
    price: "$0.03",
    icon: "🧬",
    category: "Onchain",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: holderForensics,
  },
  {
    id: "proxy-check",
    name: "Proxy / Upgrade Detector",
    tagline: "Can this contract be changed under you?",
    description:
      "Reads the EIP-1967 proxy slots live: is the contract upgradeable, what's the current implementation, and WHO can upgrade it. Flags the dangerous case — an EOA admin that can swap the logic at any block with no timelock/multisig. Upgradeability is a rug vector static scans miss.",
    price: "$0.03",
    icon: "🔀",
    category: "Onchain",
    params: [{ name: "address", label: "Contract address", placeholder: "0x… contract", required: true }],
    handler: proxyCheck,
  },
  {
    id: "contract-danger",
    name: "Contract Danger Scanner",
    tagline: "What can the owner do to you?",
    description:
      "Reads a verified contract's ABI and flags owner-callable abuse functions: mint (dilute), pause (freeze exit), blacklist (block your wallet), setFee/setTax (tax you after entry), withdraw/sweep (pull funds), upgrade (swap logic). An unverified contract is itself a red flag. Diligence a price feed can't give.",
    price: "$0.04",
    icon: "⚠️",
    category: "Onchain",
    params: [{ name: "address", label: "Contract address", placeholder: "0x… contract", required: true }],
    handler: contractDanger,
  },
  {
    id: "lp-lock",
    name: "LP Lock Details",
    tagline: "Is liquidity locked, how much, until when?",
    description:
      "Surfaces the LP holders, how much of the LP supply is locked or burned vs pullable, the lockers, and unlock dates. Unlocked liquidity is the clearest rug setup — this shows the detail a one-line 'LP locked: yes/no' hides.",
    price: "$0.02",
    icon: "🔐",
    category: "Onchain",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: lpLock,
  },
  {
    id: "deployer-rep",
    name: "Deployer Reputation",
    tagline: "Who created this token — and can you trust them?",
    description:
      "Profiles the token's creator wallet: how much history it has, how much of the supply the creator still holds, and whether ownership is renounced — rolled into a 0-100 reputation score with signals. A fresh wallet holding 20% of supply with no renounce is the classic rug setup; this is the forensics layer other checks skip.",
    price: "$0.04",
    icon: "🕵️",
    category: "Onchain",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: deployerReputation,
  },
  {
    id: "pre-sign",
    name: "Pre-Sign Preflight",
    tagline: "Should your agent sign THIS transaction? One call, one verdict",
    description:
      "The go/no-go check for the instant before signing: a live simulation of the unsigned tx (what leaves, what approvals it grants, whether it reverts), a danger scan of the destination contract (owner abuse powers), and an OFAC screen of the destination — combined into a deterministic allow / caution / would_fail / block decision with reasons. The single highest-stakes moment for an autonomous agent, covered in one call.",
    price: "$0.08",
    icon: "✍️",
    category: "Onchain",
    params: [
      { name: "from", label: "Sender address", placeholder: "0x… sender", required: true },
      { name: "to", label: "To (recipient/contract)", placeholder: "0x… recipient or contract", required: true },
      { name: "data", label: "Calldata (hex, optional)", placeholder: "0x… (for contract calls)" },
      { name: "value", label: "ETH value (optional)", placeholder: "0.1" },
    ],
    handler: preSignPreflight,
    noFreeTier: true,
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
  },
  {
    id: "token-unlock",
    name: "Token Unlock Calendar",
    tagline: "When does locked LP unlock — is a cliff coming?",
    description:
      "Turns raw LP-lock data into a forward calendar: each unlock with its date, the % of LP it frees, the locker (UNCX / Team Finance labelled), and days away — flagging imminent unlocks (<30 days). An LP unlock is a scheduled price event: the moment a rug becomes possible. For agents managing open positions.",
    price: "$0.02",
    icon: "📆",
    category: "Onchain",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: tokenUnlock,
  },
  {
    id: "volume-check",
    name: "Volume Authenticity Check",
    tagline: "Is this trading volume real — or painted on by bots?",
    description:
      "Reads the deepest pool's 24h volume, buy/sell counts, liquidity and price move, and scores how organic the activity looks. Volume 10×+ the pool's liquidity, near-perfect buy/sell symmetry, or big volume that moves the price nowhere are the classic wash-trading signatures used to bait buyers. Returns a 0-100 suspicion score and verdict.",
    price: "$0.02",
    icon: "🎭",
    category: "Markets",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: volumeCheck,
  },
  {
    id: "position-health",
    name: "Position Health Check",
    tagline: "You're IN the token — should you stay in?",
    description:
      "The post-trade check everything else skips: given a token, your position size and (optionally) entry price, returns live price & P&L, whether the position can still be EXITED at that size, and the token's current rug score — combined into a healthy / watch / exit_now verdict with reasons. The risk that changes after you buy is exactly the risk holders miss.",
    price: "$0.04",
    icon: "🩺",
    category: "Onchain",
    params: [
      { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
      { name: "size", label: "Position size USD", placeholder: "1000" },
      { name: "entryPrice", label: "Entry price USD (optional, enables P&L)", placeholder: "0.0012" },
    ],
    handler: positionHealth,
  },
  {
    id: "token-compare",
    name: "Token Compare",
    tagline: "2-5 candidates in, one ranked pick out",
    description:
      "Agents choose between tokens, not around them. Pass 2-5 Base token addresses → each gets a 0-100 quality score (safety-weighted: rug score first, then liquidity depth, then momentum), ranked best-first, with a named pick — or an honest 'none pass the gate'. One call returns a decision instead of a dozen data dumps.",
    price: "$0.05",
    icon: "⚖️",
    category: "Onchain",
    params: [{ name: "addresses", label: "Token addresses (comma-separated, 2-5)", placeholder: "0x…, 0x…", required: true }],
    handler: tokenCompare,
  },
  {
    id: "revoke-builder",
    name: "Revoke Calldata Builder",
    tagline: "The exact ready-to-sign tx that kills an approval",
    description:
      "approval-advisor tells you WHAT to revoke; this builds the HOW: the ready-to-sign transaction (to + calldata) for approve(spender, 0) on a token, plus the live current allowance read from Base (flags unlimited, or 'already revoked'). Hand the result straight to a wallet or agent signer — the action half of approval hygiene.",
    price: "$0.02",
    icon: "✂️",
    category: "Utility",
    params: [
      { name: "token", label: "Token contract", placeholder: "0x… token", required: true },
      { name: "spender", label: "Spender to revoke", placeholder: "0x… spender contract", required: true },
      { name: "wallet", label: "Your wallet (optional, reads live allowance)", placeholder: "0x… wallet" },
    ],
    handler: revokeBuilder,
  },
  {
    id: "approval-advisor",
    name: "Approval Exposure + Revoke Advisor",
    tagline: "Which approvals could drain you — and revoke order",
    description:
      "Ranks a wallet's active token approvals by USD-at-risk × unlimited-allowance × unlabelled-spender, and returns a prioritised revoke queue. Approvals are the #1 drain vector; this tells an agent exactly what to revoke first.",
    price: "$0.05",
    icon: "🧹",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: approvalAdvisor,
    noFreeTier: true,
  },
  {
    id: "portfolio-scan",
    name: "Portfolio Risk Scan",
    tagline: "Audit a whole wallet — which holdings could hurt you",
    description:
      "Pulls a wallet's holdings and runs a risk check on each, flagging which positions are honeypots / high-risk / illiquid and the USD sitting in risky tokens. One call audits the whole wallet — 'which of the things you already hold could hurt you'.",
    price: "$0.15",
    icon: "📋",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: portfolioScan,
    noFreeTier: true,
  },
  {
    id: "rug-monitor",
    name: "Rug Early-Warning Monitor",
    tagline: "Get alerted the moment liquidity is pulled",
    description:
      "Pay once to watch a Base token's liquidity. We snapshot a baseline and, on each monitor run, POST your webhook if liquidity collapses (a liquidity pull — the actual moment of a rug). Not price moving — the pool being drained out from under you. Expires after 30 days.",
    price: "$0.10",
    icon: "🚨",
    category: "Onchain",
    params: [
      { name: "token", label: "Token address", placeholder: "0x… token", required: true },
      { name: "webhook", label: "Webhook URL (https)", placeholder: "https://your-endpoint", required: true },
      { name: "dropPct", label: "Fire on liquidity drop % (default 50)", placeholder: "50" },
    ],
    handler: registerRugMonitor,
    noFreeTier: true,
  },
  {
    id: "deep-dd",
    name: "Deep Due-Diligence",
    tagline: "Institutional-grade full report on a Base token — one call",
    description:
      "The premium flagship. One call runs the FULL battery — contract risk, holder concentration, liquidity depth, EXIT liquidity (can you actually sell), OFAC sanctions — and Claude synthesizes an institutional verdict: safety score, explicit buy/sell tradeability, liquidity & holder assessments, factors, risks, positives and a recommendation. The value is the orchestration + AI synthesis you can't get in one call anywhere else.",
    price: "$0.50",
    icon: "🏛️",
    category: "AI",
    params: [
      { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
      { name: "size", label: "Position size USD (for exit check)", placeholder: "5000" },
    ],
    handler: aiDeepDueDiligence,
  },
  {
    id: "wallet-tokens",
    name: "Wallet Token Portfolio",
    tagline: "ETH + major Base token balances with USD values",
    description:
      "Returns native ETH plus WETH, USDC, USDbC, DAI, cbETH balances for any Base address, enriched with live USD values via DexScreener. Only non-zero holdings are returned.",
    price: "$0.02",
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
    price: "$0.01",
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
    price: "$0.02",
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
    price: "$0.01",
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
    price: "$0.01",
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
    price: "$0.02",
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
    price: "$0.01",
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
    price: "$0.01",
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
    price: "$0.02",
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
    price: "$0.02",
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
    price: "$0.02",
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
    price: "$0.03",
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
    price: "$0.03",
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
    price: "$0.02",
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
    price: "$0.03",
    icon: "📉",
    category: "Onchain",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: rugScore,
  },
  {
    id: "batch-risk",
    name: "Batch Token Risk Scan",
    tagline: "Rug-score up to 10 tokens in one call",
    description:
      "Screen up to 10 Base tokens in a single paid call — each gets a 0-100 rug-probability score, risk level and top signals, sorted riskiest-first. Built for agents triaging a watchlist or portfolio without paying per token.",
    price: "$0.03",
    icon: "🗂️",
    category: "Onchain",
    params: [{ name: "addresses", label: "Token addresses (comma-separated, up to 10)", placeholder: "0x…, 0x…, 0x…", required: true }],
    handler: batchRisk,
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
    noFreeTier: true, // paid-only: monitoring bots hammer this for free; make them pay (or leave)
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
    noFreeTier: true, // paid-only: discovery bots scrape this for free; make them pay (or leave)
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
    id: "wallet-portfolio",
    name: "Full Wallet Portfolio",
    tagline: "All ERC-20 holdings of a wallet with USD value",
    description:
      "Complete ERC-20 portfolio for a Base address — every non-zero token with balance, metadata and live USD value, plus a total. Powered by Alchemy (beyond the curated wallet-tokens list).",
    price: "$0.02",
    icon: "💰",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: walletPortfolio,
    noFreeTier: true,
  },
  {
    id: "wallet-networth",
    name: "Wallet Net Worth",
    tagline: "All tokens + USD value (reliable pricing)",
    description:
      "Complete ERC-20 portfolio for a Base address with accurate USD values from Covalent (handles stablecoins & long-tail tokens). Spam-filtered, sorted by value, with a total. The reliable portfolio endpoint.",
    price: "$0.02",
    icon: "🏦",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: walletNetworth,
    noFreeTier: true,
  },
  {
    id: "wallet-summary",
    name: "Wallet Age & Activity",
    tagline: "Tx count, first/last activity, wallet age",
    description:
      "Total transaction count, first & last activity timestamps, and wallet age in days for any Base address. Built for sybil/rug screening and counterparty trust checks.",
    price: "$0.03",
    icon: "🕰️",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: walletSummary,
    noFreeTier: true,
  },
  {
    id: "wallet-activity",
    name: "Wallet Activity",
    tagline: "Recent transactions for an address",
    description:
      "The latest transactions for a Base address — hash, time, from/to, ETH value, success — via Covalent. For agents tracking what a wallet is doing.",
    price: "$0.03",
    icon: "📜",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: walletActivity,
    noFreeTier: true,
  },
  {
    id: "token-approvals",
    name: "Token Approval Risk",
    tagline: "Open allowances & USD at risk for a wallet",
    description:
      "Lists a wallet's active token approvals — which contracts can spend its tokens, the allowance, USD value at risk and a risk factor (revoke.cash-style). Essential wallet-security check for agents and users.",
    price: "$0.02",
    icon: "🔓",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: tokenApprovals,
    noFreeTier: true,
  },
  {
    id: "historical-price",
    name: "Historical Token Price",
    tagline: "USD price of a Base token on a given date",
    description:
      "Returns the USD price of a Base token on a specific date (YYYY-MM-DD) via Covalent. For agents computing cost basis, backtests, or P&L.",
    price: "$0.02",
    icon: "📅",
    category: "Markets",
    params: [
      { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
      { name: "date", label: "Date (YYYY-MM-DD)", placeholder: "2026-06-01", required: true },
    ],
    handler: historicalPrice,
    noFreeTier: true,
  },
  {
    id: "token-transfers",
    name: "Token Transfer History",
    tagline: "A wallet's in/out transfers of a token",
    description:
      "Recent transfers of a specific token for a wallet — direction (in/out), amount, USD value, counterparty, tx hash and time, via Covalent. For agents tracking token flows and cost basis.",
    price: "$0.03",
    icon: "🔁",
    category: "Onchain",
    params: [
      { name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true },
      { name: "token", label: "Token contract", placeholder: "0x… token", required: true },
    ],
    handler: tokenTransfers,
    noFreeTier: true,
  },
  {
    id: "wallet-nfts",
    name: "Wallet NFT Holdings",
    tagline: "NFT collections held by a wallet (+ floor)",
    description:
      "Lists the NFT collections a Base wallet holds — name, count and floor value — spam-filtered, via Covalent. For agents profiling a wallet's NFT exposure.",
    price: "$0.02",
    icon: "🖼️",
    category: "Onchain",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: walletNfts,
    noFreeTier: true,
  },
  {
    id: "ai-wallet-report",
    name: "AI Wallet Report",
    tagline: "Claude-written verdict on any wallet",
    description:
      "The flagship wallet report: aggregates net worth, age/activity and recent transactions, then Claude synthesizes a verdict (e.g. fresh/risky → established/active) with key observations. One call, agent-ready wallet intelligence.",
    price: "$0.06",
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
    price: "$0.08",
    icon: "🔬",
    category: "AI",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: aiTokenReport,
  },
  {
    id: "ai-market-brief",
    name: "AI Market Brief",
    tagline: "Claude-written situational brief of the Base token market",
    description:
      "The zoom-out flagship: aggregates trending and newly-listed Base tokens, then Claude writes a concise market brief — mood, highlights, new & notable launches, and cautions (fresh/unknown tokens flagged for rug risk). One call gives a trading agent market context instead of dozens of lookups.",
    price: "$0.05",
    icon: "🗞️",
    category: "AI",
    params: [],
    handler: aiMarketBrief,
  },
  {
    id: "ai-wallet-security",
    name: "AI Wallet Security Audit",
    tagline: "What can drain this wallet — and what to revoke",
    description:
      "Pulls a wallet's active token approvals and Claude writes a security audit: overall risk level, USD at risk, and concrete revoke recommendations (which token/spender and why). The wallet-safety check agents and users run before trusting an address.",
    price: "$0.06",
    icon: "🛡️",
    category: "AI",
    params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: aiWalletSecurity,
  },
  {
    id: "ai-tx-explain",
    name: "AI Transaction Explainer",
    tagline: "Plain-English explanation of any Base transaction",
    description:
      "Give a Base transaction hash and Claude explains what it actually did in plain English — the action, a risk read (failed tx, risky approval, high-value transfer), and notes. Turns raw calldata into an answer agents and humans can use.",
    price: "$0.04",
    icon: "💬",
    category: "AI",
    params: [{ name: "hash", label: "Transaction hash", placeholder: "0x… (66 hex characters)", required: true }],
    handler: aiTxExplain,
  },
  {
    id: "ai-contract-risk",
    name: "AI Contract Risk Explainer",
    tagline: "What dangerous powers a contract has, in plain English",
    description:
      "Combines security flags with the verified ABI's function names, then Claude explains the contract's dangerous capabilities — owner can mint, pause, blacklist, upgrade or self-destruct — with a danger level. Goes beyond raw flags to read what the contract can actually do.",
    price: "$0.04",
    icon: "📜",
    category: "AI",
    params: [{ name: "address", label: "Contract address", placeholder: "0x… contract", required: true }],
    handler: aiContractRisk,
  },
  {
    id: "ai-summarize",
    name: "AI Summarize",
    tagline: "Any text → crisp bullet points",
    description:
      "Paste text and get a 3-5 bullet summary from Claude. Pay-per-call — no API key or subscription needed on your side.",
    price: "$0.03",
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
    price: "$0.03",
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
    price: "$0.03",
    icon: "🌐",
    category: "AI",
    params: [
      { name: "text", label: "Text to translate", placeholder: "Merhaba dünya…", required: true, multiline: true },
      { name: "to", label: "Target language", placeholder: "English" },
    ],
    handler: aiTranslate,
  },
  {
    id: "secure-token",
    name: "Secure Token",
    tagline: "Cryptographically strong random IDs",
    description:
      "Generate N url-safe random tokens server-side. Demonstrates a paid utility endpoint with a query parameter.",
    price: "$0.005",
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
