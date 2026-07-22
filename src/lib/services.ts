/**
 * The marketplace catalog.
 *
 * Each entry is an x402-protected, pay-per-call API. The `handler` produces the
 * actual response a buyer receives *after* their payment settles. Everything is
 * self-contained (no external API keys) so the marketplace runs out of the box — but
 * each handler is a normal async function, so swapping in a real upstream API or
 * an LLM call is a one-line change.
 */

import { aiSummarize, aiExtract, aiExtractBatch, aiTranslate } from "./ai";
import { tokenRisk, addressIntel } from "./onchain";
import { gasOracle, tokenPrice, txDecode, multiTokenPrice, pairInfo, tokenPools } from "./onchain-extra";
import { holderDistribution } from "./holders";
import { walletTokens, trendingTokens } from "./onchain-extra2";
import { registerAlert } from "./alerts";
import { contractAbi, decodeSelector, encodeSelector } from "./onchain-extra3";
import { basenameResolve, ensResolve, basenameProfile } from "./basename";
import { sanctionsCheck, complianceCheck, sanctionsBatch } from "./compliance";
import { newTokens } from "./onchain-extra4";
import { aiTokenReport, aiMarketBrief } from "./ai-report";
import { rugScore } from "./scores";
import { tokenMomentum, tokenInfo, chainStatus } from "./market";
import { nftFloor, walletPortfolio } from "./alchemy";
import { walletNetworth, walletSummary, walletActivity, tokenApprovals, historicalPrice, walletNfts, tokenTransfers } from "./covalent";
import { aiWalletReport, aiWalletSecurity, aiTxExplain, aiContractRisk, aiDeepDueDiligence, b20Dossier } from "./ai-report";
import { agentWalletAudit } from "./agent-wallet-audit";
import { walletDelegation } from "./delegation";
import { commerceEscrow, commerceOperatorAudit } from "./commerce";
import { morphoHealth, morphoLiquidations } from "./morpho";
import { gasSponsor, paymasterAudit } from "./aa";
import { metamorphoVault } from "./vault";
import { safeCheck } from "./safe";
import { firstFunder } from "./provenance";
import { freshBridge } from "./bridge";
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
import { signGuard } from "./sign-guard";
import { spendAudit } from "./spend-audit";
import { addressTrust } from "./address-trust";
import { swapRoute } from "./swap-route";
import { tokenUnlock } from "./token-unlock";
import { volumeCheck } from "./volume-check";
import { positionHealth } from "./position-health";
import { tokenCompare } from "./token-compare";
import { revokeBuilder } from "./revoke-builder";
import { preTradeGate } from "./gate";
import { whaleFlow } from "./whale-flow";
import { watchlistDiff } from "./watchlist";
import { b20Safety, b20Info, b20FreezeCheck, b20Rebase, b20Batch, b20LaunchRadar, b20PolicyWatch, b20Guard, b20Gate, b20TransferPreflight, b20Portfolio, b20Control, b20Memo, b20Supply, b20Metadata, b20Permit, b20PolicyAdmin, b20AccessType, b20Announcements, b20Stablecoin, b20SeizureHistory, b20Authenticity, b20ConfigAudit, b20PolicyMembers, b20GenesisAudit, b20MintWatch, b20RebaseHistory, b20Peg } from "./b20-safety";
import { baseWithdrawal } from "./base-withdrawal";
import { buyCredits } from "./credits";

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
  /** Hidden from the marketplace UI + public catalog listing (still callable/indexed). */
  hidden?: boolean;
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
    noFreeTier: true, // free-tier disabled so CDP Bazaar indexes it (free-eligible resources aren't indexed)
  },
  {
    id: "pre-trade-gate",
    name: "Pre-Trade Gate",
    tagline: "One call before you trade — GO / HOLD / STOP",
    description:
      "The single call an agent makes before touching a Base token: token risk + sellability (honeypot/tax) + route/price-impact + deployer reputation, collapsed into one GO/HOLD/STOP verdict with an auditable receipt. Cheaper than the four checks à la carte. This is the tool to bind first.",
    price: "$0.10",
    icon: "🚦",
    category: "Onchain",
    params: [
      { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
      { name: "amountUsd", label: "Trade size in USD (optional)", placeholder: "1000" },
    ],
    handler: preTradeGate,
    noFreeTier: true,
  },
  {
    id: "sign-guard",
    name: "Sign Guard",
    tagline: "Should the agent sign THIS calldata? GO/HOLD/STOP",
    description:
      "The check before the riskiest moment — signing. Decodes raw unsigned calldata (approve / permit / transfer / setApprovalForAll), shows the exact intent (who gets power over what, and whether it's UNLIMITED), and screens the destination + spender for OFAC sanctions and dangerous owner powers, in one GO/HOLD/STOP verdict + receipt. No simulation needed — pure decode + onchain risk. Catches the unlimited-approval drain vector before it's signed.",
    price: "$0.06",
    icon: "✍️",
    category: "Onchain",
    params: [
      { name: "data", label: "Transaction calldata (0x…)", placeholder: "0x095ea7b3…", required: true },
      { name: "to", label: "Destination contract/token (recommended)", placeholder: "0x… contract" },
    ],
    handler: signGuard,
    noFreeTier: true,
  },
  {
    id: "spend-audit",
    name: "Spend Permission Auditor",
    tagline: "Which apps/agents can pull funds from this Base wallet?",
    description:
      "🆕 Base Account spend permissions let an app or agent spend a scoped, recurring allowance from a wallet — the primitive behind autonomous agent payments on Base. This reconstructs a wallet's ACTIVE spend permissions from onchain approve/revoke events and flags the dangerous ones: unlimited allowance, no expiry, unrecognized spender. The Base-native, agent-era drain check that ERC-20 approval tools can't see.",
    price: "$0.05",
    icon: "🔑",
    category: "Onchain",
    params: [{ name: "wallet", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: spendAudit,
    noFreeTier: true,
  },
  {
    id: "agent-wallet-audit",
    name: "Agent Wallet Audit",
    tagline: "Every way this wallet can be drained without a fresh signature",
    description:
      "🆕 The complete fund-movement authority on a Base wallet in one call: ERC-20 approvals (a spender you approved can pull the token) PLUS Base Account spend permissions (the agent-era scoped recurring allowance) — one drain-surface verdict with the ERC-20 revoke queue to act on. Approval tools miss the spend permissions; spend-permission tools miss the approvals. The only combined check for agent wallets that must know their whole exposure before holding funds.",
    price: "$0.06",
    icon: "🛡️",
    category: "Onchain",
    params: [{ name: "wallet", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: agentWalletAudit,
    noFreeTier: true,
  },
  {
    id: "wallet-delegation",
    name: "7702 Delegation Check",
    tagline: "Is this EOA secretly running someone else's code?",
    description:
      "🆕 Since Pectra an EOA can carry EIP-7702 delegated code (the 0xef0100 designator): every call to the wallet executes the DELEGATE's contract with the wallet's funds — a malicious delegate is total takeover, invisible to approval tools. Reads the designator, resolves the delegate and verdicts it: not_delegated / delegated_known (Coinbase's EOA→SmartWallet path) / delegated_unknown (🚨) / smart_contract. The drain surface no other Base tool checks.",
    price: "$0.03",
    icon: "🎭",
    category: "Onchain",
    params: [{ name: "wallet", label: "EOA address", placeholder: "0x… wallet", required: true }],
    handler: walletDelegation,
    noFreeTier: true,
  },
  {
    id: "commerce-escrow",
    name: "Commerce Escrow Status",
    tagline: "Auth/capture payment reconciliation on Base",
    description:
      "🆕 First tooling for Base's Commerce Payments protocol (AuthCaptureEscrow): reconciles two-phase auth/capture payments — in escrow, captured, charged, voided, refunded, or payer-RECLAIMABLE because the operator missed the capture window. Filter by payment= (infoHash), payer=, receiver= or operator=, or omit everything for the network feed. The order-reconciliation read merchants and agents need before trusting onchain commerce.",
    price: "$0.04",
    icon: "🛒",
    category: "Onchain",
    params: [
      { name: "payment", label: "PaymentInfo hash (optional)", placeholder: "0x… 32-byte hash" },
      { name: "payer", label: "Payer wallet (optional)", placeholder: "0x… payer" },
      { name: "receiver", label: "Merchant wallet (optional)", placeholder: "0x… merchant" },
      { name: "operator", label: "Operator (optional)", placeholder: "0x… operator" },
    ],
    handler: commerceEscrow,
    noFreeTier: true,
  },
  {
    id: "commerce-operator-audit",
    name: "Payment Operator Audit",
    tagline: "Should you trust this Commerce Payments operator?",
    description:
      "🆕 Commerce Payments flows are DRIVEN by an operator — it authorizes escrow, captures for merchants and takes the fees. This audits one before you rely on it: 90-day volumes, fees taken, capture-vs-reclaim record (missed capture windows = merchants left unpaid), distinct payers and merchants. verdict: healthy_operator / mixed / sloppy_operator / no_activity. No other tool reads this new Base commerce protocol.",
    price: "$0.05",
    icon: "🕴️",
    category: "Onchain",
    params: [{ name: "operator", label: "Operator address", placeholder: "0x… operator", required: true }],
    handler: commerceOperatorAudit,
    noFreeTier: true,
  },
  {
    id: "morpho-health",
    name: "Morpho Position Health",
    tagline: "Is this Morpho lending position about to be liquidated?",
    description:
      "🆕 First lending tooling in the catalog. Reads a Morpho Blue position on Base (the largest lending venue on Base) and returns its liquidation health in one call: health factor, current vs liquidation LTV, and the exact collateral price drop that triggers liquidation. Built for borrowing agents and treasuries that need to know how close they are before the market cuts them — Morpho's own API is deferred. Pass wallet= and optionally market= (defaults to cbBTC/USDC). Not financial advice.",
    price: "$0.04",
    icon: "🏦",
    category: "Lending",
    params: [
      { name: "wallet", label: "Borrower wallet", placeholder: "0x… wallet", required: true },
      { name: "market", label: "Morpho market id (optional)", placeholder: "0x… 32-byte id (default cbBTC/USDC)" },
    ],
    handler: morphoHealth,
    noFreeTier: true,
  },
  {
    id: "morpho-vault",
    name: "Morpho Vault Risk",
    tagline: "Should you deposit into this MetaMorpho vault?",
    description:
      "🆕 The depositor-side complement to Morpho Position Health. A MetaMorpho vault spreads your deposit across Morpho Blue markets — your real risk is WHERE the curator put it and WHO can move it. Reads the vault's live allocation across markets (concentration, per-market collateral + liquidation LTV), idle share, performance fee, timelock, and control (curator/owner/guardian, and whether one address holds both). Returns a diversified / concentrated / control_risk verdict. The read an agent pulls before parking funds in a yield vault — no other Base tool surfaces it. vault= required. Not financial advice.",
    price: "$0.05",
    icon: "🗄️",
    category: "Lending",
    params: [{ name: "vault", label: "MetaMorpho vault address", placeholder: "0x… vault", required: true }],
    handler: metamorphoVault,
    noFreeTier: true,
    hidden: true,
  },
  {
    id: "morpho-liquidatable",
    name: "Morpho Liquidation Feed",
    tagline: "Which Base Morpho positions are liquidatable right now?",
    description:
      "🆕 Built for liquidator / MEV searchers. Reconstructs the active borrower set on a Morpho Blue market from Borrow events, prices every position onchain in one multicall, and ranks them by liquidation health — flagging positions liquidatable NOW (health <= 1.0) and those one small move away, with the collateral price drop that tips each over. The data directly makes searchers money; nobody else in the catalog serves it. market= optional (defaults cbBTC/USDC), maxHealth= cutoff (default 1.1). Not financial advice.",
    price: "$0.06",
    icon: "⚔️",
    category: "Lending",
    params: [
      { name: "market", label: "Morpho market id (optional)", placeholder: "0x… 32-byte id (default cbBTC/USDC)" },
      { name: "maxHealth", label: "Health cutoff (optional)", placeholder: "1.1 (<=1.0 = already liquidatable)" },
    ],
    handler: morphoLiquidations,
    noFreeTier: true,
    // Hidden from the storefront: the handler is correct and settles via the
    // credit path, but the CDP facilitator rejects this resource's x402
    // pay-per-call at verify (no charge, handler never runs) despite payment
    // requirements byte-identical to services that pay. Unhide once the x402
    // direct-pay path works so agents don't hit a dead payment loop.
    hidden: true,
  },
  {
    id: "gas-payer",
    name: "Gas Sponsor Check",
    tagline: "Who pays this wallet's gas? Is it a sponsored smart account?",
    description:
      "🆕 The first onchain gas-sponsorship read on Base. Base pushes ERC-4337 smart accounts, and a smart account's gas can be paid by a PAYMASTER instead of the account itself — invisible to every 'does this wallet spend ETH' heuristic and to approval/delegation tools. Reads a wallet's UserOperationEvents across BOTH EntryPoints (v0.6 + v0.7) and returns: is it a smart account, its op count and success rate, and WHO sponsors its gas (self vs which paymaster, with per-sponsor share). A fully-sponsored account is typically app- or agent-operated — a real counterparty signal no other tool serves. wallet= required, days= optional (default 30, max 90). Not financial advice.",
    price: "$0.05",
    icon: "⛽",
    category: "Accounts",
    params: [
      { name: "wallet", label: "Wallet address", placeholder: "0x... smart account / agent wallet", required: true },
      { name: "days", label: "Lookback days (optional)", placeholder: "30 (max 90)" },
    ],
    handler: gasSponsor,
    noFreeTier: true,
    // Hidden pending the x402 first-settlement issue (same as morpho-liquidations):
    // handler is correct and settles via the credit path, but the CDP facilitator
    // rejects this new resource's x402 pay-per-call at verify despite payment
    // requirements byte-identical to services that pay (morpho-health, an equally
    // new resource, settles fine). Matches the CDP discovery/settlement pipeline
    // issue tracked in cdp-sdk#759. Unhide once new resources settle on x402.
    hidden: true,
  },
  {
    id: "paymaster-check",
    name: "Paymaster Check",
    tagline: "Should you trust this Base gas paymaster?",
    description:
      "🆕 The gas-sponsor sibling, for the OTHER side: given a paymaster address, audits whether it's a healthy, active gas sponsor. Reads its UserOperationEvents across both EntryPoints and returns sponsored op volume, distinct accounts served, success rate, total gas sponsored, and concentration (share from its busiest app). The read a builder pulls before integrating a paymaster (Coinbase / Pimlico / Alchemy / custom), or an agent pulls to judge who funds a counterparty's gas. No other tool serves it. paymaster= required, days= optional (default 30, max 90). Not financial advice.",
    price: "$0.05",
    icon: "🛢️",
    category: "Accounts",
    params: [
      { name: "paymaster", label: "Paymaster address", placeholder: "0x... paymaster", required: true },
      { name: "days", label: "Lookback days (optional)", placeholder: "30 (max 90)" },
    ],
    handler: paymasterAudit,
    noFreeTier: true,
    hidden: true,
  },
  {
    id: "safe-check",
    name: "Safe Multisig Check",
    tagline: "Real M-of-N multisig, or a 1-of-1 that just looks like one?",
    description:
      "🆕 Multisig / treasury intelligence. A huge share of Base treasuries, DAOs and app wallets are Gnosis Safes. Given an address: is it a Safe, its owners and M-of-N threshold, version, activity, and — critically — its enabled MODULES. An enabled module can move the Safe's funds via execTransactionFromModule WITHOUT any owner signatures, so every module is an address with unilateral control (the same drain surface a rogue 7702 delegate is for an EOA). Returns a multisig / single_signer / has_modules verdict. The counterparty/treasury check no other Base tool serves before you trust funds to a multisig. address= required. Not financial advice.",
    price: "$0.04",
    icon: "🔐",
    category: "Accounts",
    params: [{ name: "address", label: "Address to check", placeholder: "0x… Safe / treasury / counterparty", required: true }],
    handler: safeCheck,
    noFreeTier: true,
    hidden: true,
  },
  {
    id: "first-funder",
    name: "First Funder",
    tagline: "Where did this wallet's money originally come from?",
    description:
      "🆕 Funding provenance in one call. Traces a Base wallet back to its EARLIEST transaction and resolves who first funded it: a recognized exchange/bridge (real on-ramp, lower risk), an anon EOA (possible sybil/burner — trace the cluster), or a contract. Returns the first funder, whether it's a contract or EOA, the initial value, and wallet age. The sybil/origin screen no other Base tool gives — the counterparty check before you transact. wallet= required. Not financial advice.",
    price: "$0.04",
    icon: "🌱",
    category: "Onchain",
    params: [{ name: "wallet", label: "Wallet address", placeholder: "0x... wallet to trace", required: true }],
    handler: firstFunder,
    noFreeTier: true,
  },
  {
    id: "fresh-bridge",
    name: "Fresh Bridge Check",
    tagline: "Is this wallet's USDC freshly bridged, and from where?",
    description:
      "🆕 Cross-chain inflow detection. Reads a wallet's recent USDC MINTS and correlates them with Circle CCTP receives to tell you whether its USDC is freshly bridged in (and from which source chain — Ethereum, Arbitrum, OP, Polygon, Solana…) vs natively issued. Freshly bridged capital is new money / a possible cross-chain hop — a real signal for trading and liquidation agents that no other Base tool surfaces. wallet= required, days= optional (default 30, max 90). Not financial advice.",
    price: "$0.04",
    icon: "🌉",
    category: "Onchain",
    params: [
      { name: "wallet", label: "Wallet address", placeholder: "0x... wallet", required: true },
      { name: "days", label: "Lookback days (optional)", placeholder: "30 (max 90)" },
    ],
    handler: freshBridge,
    noFreeTier: true,
  },
  {
    id: "address-trust",
    name: "Address Trust",
    tagline: "Is this counterparty Coinbase-verified or an anon/sybil?",
    description:
      "🆕 The 'who am I dealing with?' check for agents. Reads Coinbase's ONCHAIN verification (an EAS attestation by verifications.coinbase.eth) — meaning the address is tied to a KYC'd Coinbase account, the strongest sybil-resistance signal on Base — plus the address's Basename. Returns a verified/named/anonymous verdict + trust score. Pair with sign-guard/spend-audit for a full pre-transaction gate. Identity is a signal, not proof of honesty.",
    price: "$0.03",
    icon: "🪪",
    category: "Onchain",
    params: [{ name: "address", label: "Address to check", placeholder: "0x… wallet/agent", required: true }],
    handler: addressTrust,
    noFreeTier: true,
  },
  {
    id: "basename-profile",
    name: "Basename Profile",
    tagline: "Full onchain identity behind a Basename or address",
    description:
      "🆕 Resolves the complete Base identity behind an address or Basename: resolved address, avatar, description, website and social handles (X/Twitter, GitHub, Farcaster, Discord) read from Base's L2 Resolver text records. Lets an agent turn a counterparty address into a real profile — beyond just the name. Complements address-trust (verification) with the human context.",
    price: "$0.02",
    icon: "🏷️",
    category: "Onchain",
    params: [{ name: "name", label: "Basename or address", placeholder: "jesse.base.eth or 0x…", required: true }],
    handler: basenameProfile,
    noFreeTier: true,
  },
  {
    id: "whale-flow",
    name: "Whale Flow",
    tagline: "Is size moving to the exits right now?",
    description:
      "Flow, not snapshot: the largest transfers of a Base token in the last 24h, classified by whether whales are sending INTO DEX pools (sell pressure) or pulling OUT (accumulation) — a net sell-pressure read that decays in hours. Complements holder-forensics ('who could dump') with 'is anyone dumping now'. CDP-indexed events.",
    price: "$0.04",
    icon: "🐋",
    category: "Onchain",
    params: [
      { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
      { name: "hours", label: "Window in hours (default 24, max 72)", placeholder: "24" },
    ],
    handler: whaleFlow,
    noFreeTier: true,
  },
  {
    id: "watchlist-diff",
    name: "Watchlist Diff",
    tagline: "What changed on my tokens since last check?",
    description:
      "Retention in one call: pass up to 10 tokens to snapshot them and get a watchId; call again with that watchId to get only the DELTAS since last time — liquidity ±%, price ±%, became-honeypot, sell-tax spiked, liquidity pulled. The second call is worth more than the first. Built for agents holding positions that re-check daily.",
    price: "$0.06",
    icon: "📋",
    category: "Onchain",
    params: [
      { name: "tokens", label: "Up to 10 token addresses (comma-separated)", placeholder: "0x…, 0x…" },
      { name: "watchId", label: "Or: watchId to re-check an existing list", placeholder: "wl_…" },
    ],
    handler: watchlistDiff,
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
    id: "b20-safety",
    name: "B20 Token Safety",
    tagline: "Can this Base-native (B20) token freeze or seize your funds?",
    description:
      "🆕 Live — B20 is Base's native precompile token standard, and unlike ERC-20 a B20 issuer can freeze holders (Policy Registry) and even SEIZE your balance (burnBlocked) at the protocol level. This reads exactly those powers — seizable, freezable, paused, rebase, uncapped-mint — into one hold/caution/avoid verdict. The first B20-aware safety check on Base.",
    price: "$0.04",
    icon: "🆕",
    category: "B20",
    params: [{ name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true }],
    handler: b20Safety,
    noFreeTier: true,
  },
  {
    id: "b20-gate",
    name: "B20 Pre-Trade Gate",
    tagline: "One GO/HOLD/STOP before you touch a B20 token",
    description:
      "🆕 The single call before trading a Base-native B20: seize (burnBlocked) + freeze (Policy Registry) + rebase + pause + uncapped-mint, collapsed into one GO/HOLD/STOP verdict with an auditable receipt. Pass wallet= to also check if YOUR address is already blocked on that token. The B20 tool to bind first.",
    price: "$0.10",
    icon: "🚦",
    category: "B20",
    params: [
      { name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true },
      { name: "wallet", label: "Your wallet (optional — checks if you're blocked)", placeholder: "0x… wallet" },
    ],
    handler: b20Gate,
    noFreeTier: true,
  },
  {
    id: "b20-transfer-preflight",
    name: "B20 Transfer Preflight",
    tagline: "Will THIS transfer (from→to) clear right now?",
    description:
      "🆕 The per-transaction B20 rail check: pass token + from + to (+ optional executor) and get one GO/HOLD/STOP on whether this exact transfer clears NOW — sender policy resolved against the sender, receiver policy against the recipient, executor policy against the operator, plus live transfer-pause. Every other B20 tool is per-token due diligence bought once; this is the check an agent runs on every payment. No ERC-20 tool can see it.",
    price: "$0.04",
    icon: "🚦",
    category: "B20",
    params: [
      { name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true },
      { name: "from", label: "Sender address", placeholder: "0x… sender", required: true },
      { name: "to", label: "Recipient address", placeholder: "0x… recipient", required: true },
      { name: "executor", label: "Executor (optional — transferFrom operator)", placeholder: "0x… operator" },
    ],
    handler: b20TransferPreflight,
    noFreeTier: true,
  },
  {
    id: "b20-portfolio",
    name: "B20 Portfolio Guard",
    tagline: "Which B20s in your wallet can freeze or seize you?",
    description:
      "🆕 Scans a wallet's B20 (Base-native) holdings for protocol-level freeze/seize powers and whether YOUR address is ALREADY blocked on any of them — the risk no ERC-20 portfolio tool can see. Returns per-token seizable/freezable/rebase flags plus a wallet-level verdict. Built for agents holding Base positions.",
    price: "$0.06",
    icon: "🛡️",
    category: "B20",
    params: [{ name: "wallet", label: "Wallet address", placeholder: "0x… wallet", required: true }],
    handler: b20Portfolio,
    noFreeTier: true,
  },
  {
    id: "b20-control",
    name: "B20 Control Audit",
    tagline: "WHO can mint, seize, freeze or pause this B20?",
    description:
      "🆕 b20-safety tells you WHICH powers a B20 has; this tells you WHO holds them. Reads the token's role-based access control (mint / burn / seize-via-burnBlocked / pause / admin) from onchain role events and reports the exact controllers, how centralized they are, and whether admin has been renounced. The issuer-control map an agent needs before holding a regulated Base-native asset.",
    price: "$0.05",
    icon: "👑",
    category: "B20",
    params: [{ name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true }],
    handler: b20Control,
    noFreeTier: true,
  },
  {
    id: "b20-seizure-history",
    name: "B20 Seizure History",
    tagline: "Has this issuer ever actually SEIZED holders?",
    description:
      "🆕 Every other B20 check reads what the issuer CAN do; this reads what they HAVE done. Scans the token's actual burnBlocked seizures (the distinct BurnedBlocked event) — whether the issuer has ever burned a blocked holder's balance, who was seized, and how much. verdict: enforced (has seized) / armed (can, hasn't) / no_seize_power. Pass wallet= to check a specific address, or omit address= for the network-wide seizure feed. The enforcement-history signal no ERC-20 or other B20 tool can show.",
    price: "$0.05",
    icon: "🔫",
    category: "B20",
    params: [
      { name: "address", label: "B20 token (omit for network feed)", placeholder: "0x… B20 token" },
      { name: "wallet", label: "Victim wallet (optional)", placeholder: "0x… wallet" },
    ],
    handler: b20SeizureHistory,
    noFreeTier: true,
  },
  {
    id: "b20-authenticity",
    name: "B20 Authenticity Check",
    tagline: "Is this a REAL B20 — or a lookalike contract?",
    description:
      "🆕 Run FIRST on any 'B20'. A scammer can deploy a normal contract at a vanity 0xB200… address and fake the whole B20 read surface — the B20Factory precompile is the one authority that can't be spoofed. Verifies factory registration + bytecode absence (real B20s are chain-native precompiles with no code). verdict: genuine / fake_lookalike / not_b20. The 2-cent check that keeps every other B20 answer honest.",
    price: "$0.02",
    icon: "🕵️",
    category: "B20",
    params: [{ name: "address", label: "Token address", placeholder: "0x… token", required: true }],
    handler: b20Authenticity,
    noFreeTier: true,
  },
  {
    id: "b20-config-audit",
    name: "B20 Config Audit",
    tagline: "Bricked scopes, dangling policies, frozen lists",
    description:
      "🆕 The B20 misconfiguration lint. Base's docs warn: a scope bound to a NON-EXISTENT allowlist silently denies EVERYONE — transfers brick. Audits every policy scope for dangling bindings, ALWAYS_BLOCK, renounced (frozen) lists and live pauses; verdict bricked / critical_misconfig / misconfigured / clean plus a can-this-token-even-move flag. Pre-launch lint for issuers, stuck-funds guard for holders and merchants.",
    price: "$0.05",
    icon: "🩺",
    category: "B20",
    params: [{ name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true }],
    handler: b20ConfigAudit,
    noFreeTier: true,
  },
  {
    id: "b20-policy-members",
    name: "B20 Policy Members",
    tagline: "The FULL blocklist/allowlist — every address, with history",
    description:
      "🆕 b20-freeze-check answers one wallet; this enumerates the WHOLE list. Replays the Policy Registry's BlocklistUpdated/AllowlistUpdated events into the full membership of a B20's blocklist/allowlist: every address ever blocked or whitelisted, when, by whom, and the current member set per scope. Compliance-grade visibility no other tool provides. Pass address= (token) or policy= (registry policy ID).",
    price: "$0.05",
    icon: "📋",
    category: "B20",
    params: [
      { name: "address", label: "B20 token address", placeholder: "0x… B20 token" },
      { name: "policy", label: "Registry policy ID (optional)", placeholder: "e.g. 2" },
    ],
    handler: b20PolicyMembers,
    noFreeTier: true,
  },
  {
    id: "b20-genesis-audit",
    name: "B20 Genesis Audit",
    tagline: "What the issuer did in the initCalls bypass window",
    description:
      "🆕 createB20's initCalls run with role AND transfer-policy gates BYPASSED — a one-tx privilege window only the issuer ever gets. Reconstructs what they did in it: pre-mints (how much, to whom), role grants, policy bindings, blocklist seeding — the token's true starting conditions. verdict: blocklist_seeded / premined / configured_launch / bare_launch.",
    price: "$0.04",
    icon: "🧬",
    category: "B20",
    params: [{ name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true }],
    handler: b20GenesisAudit,
    noFreeTier: true,
  },
  {
    id: "b20-mint-watch",
    name: "B20 Mint Watch",
    tagline: "Who is printing this token, right now",
    description:
      "🆕 b20-supply shows the dilution ceiling; this shows the actual printing. Every mint (incl. batchMint) in the window: amount, recipients, and the share of current supply it represents — heavy_dilution / active_minting / minor_minting / quiet. The live issuance feed for agents holding B20 stablecoins and RWAs. Pass days= (1-90, default 30).",
    price: "$0.03",
    icon: "🖨️",
    category: "B20",
    params: [
      { name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true },
      { name: "days", label: "Window in days (default 30)", placeholder: "30" },
    ],
    handler: b20MintWatch,
    noFreeTier: true,
  },
  {
    id: "b20-rebase-history",
    name: "B20 Rebase History",
    tagline: "Every silent balance rescaling this token ever did",
    description:
      "🆕 An Asset B20's multiplier rescales EVERY holder's balance in one call — no transfer, no per-account event, nothing in your tx history. b20-rebase shows today's value; this replays the full MultiplierUpdated history and flags DOWNWARD moves that silently cut every holder. The operator's rebase track record, before you hold a rebasing RWA.",
    price: "$0.03",
    icon: "📉",
    category: "B20",
    params: [{ name: "address", label: "B20 Asset token address", placeholder: "0x… B20 token", required: true }],
    handler: b20RebaseHistory,
    noFreeTier: true,
  },
  {
    id: "b20-peg",
    name: "B20 Peg Check",
    tagline: "Declared currency vs what the market actually pays",
    description:
      "🆕 A B20 Stablecoin's currency() is SELF-DECLARED — the standard verifies nothing. This is the missing check: declared peg vs actual DEX market price. 'Says USD, trades at $0.71' in one call: on_peg / depeg_warning / depegged / no_market (the peg is a pure claim with zero price discovery) / unverifiable_fx for non-USD pegs. Run before settling in any B20 stablecoin.",
    price: "$0.03",
    icon: "⚖️",
    category: "B20",
    params: [{ name: "address", label: "B20 stablecoin address", placeholder: "0x… B20 token", required: true }],
    handler: b20Peg,
    noFreeTier: true,
  },
  {
    id: "b20-dossier",
    name: "B20 Due-Diligence Dossier",
    tagline: "Institutional AI report on a Base-native B20 token",
    description:
      "🆕 The premium tier of the B20 suite — no ERC-20 tool can produce it. Composes the full B20 picture: seize/freeze/pause/mint powers, WHO holds them (admin renounced?), allowlist-vs-blocklist access model, supply-cap dilution headroom, metadata mutability, and ACTUAL seizure history (burnBlocked) — then Claude writes an institutional due-diligence verdict: issuer-control score, seizure risk (enforced/armed/none), red flags, and a hold/avoid recommendation.",
    price: "$0.75",
    icon: "📚",
    category: "B20",
    params: [{ name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true }],
    handler: b20Dossier,
    noFreeTier: true,
  },
  {
    id: "b20-memo",
    name: "B20 Memo Tracker",
    tagline: "Payment IDs & compliance tags on a B20 token",
    description:
      "🆕 B20 adds memos to transfers/mints/burns (transferWithMemo) for payment IDs, compliance tags and settlement correlation — a field ERC-20 has no equivalent for. Reads a token's on-chain Memo event history, optionally filtered by a specific memo (bytes32) or the caller wallet. The settlement-reconciliation primitive for agents paying over B20 stablecoins.",
    price: "$0.03",
    icon: "🧾",
    category: "B20",
    params: [
      { name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true },
      { name: "memo", label: "Filter by memo (bytes32, optional)", placeholder: "0x…" },
      { name: "caller", label: "Filter by caller wallet (optional)", placeholder: "0x…" },
    ],
    handler: b20Memo,
    noFreeTier: true,
  },
  {
    id: "b20-supply",
    name: "B20 Supply Guard",
    tagline: "Mint headroom & dilution history of a B20",
    description:
      "🆕 The dilution half of B20 rug risk (b20-safety covers seizure). Reads supply cap vs minted supply (how much can still be minted) plus the on-chain SupplyCapUpdated history — an issuer that RAISED the cap diluted, or set up to dilute, holders. Uncapped mint is flagged as the worst case. Pair with b20-control to see who holds the mint role.",
    price: "$0.04",
    icon: "🏦",
    category: "B20",
    params: [{ name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true }],
    handler: b20Supply,
    noFreeTier: true,
  },
  {
    id: "b20-metadata",
    name: "B20 Metadata Integrity",
    tagline: "Can this token rename itself? Has it?",
    description:
      "🆕 A B20 with a METADATA_ROLE holder can call updateName/updateSymbol — change its own identity after launch (an impersonation / bait-and-switch vector ERC-20 has no protocol equivalent for). Reads whether the metadata is mutable (role holder exists) AND whether it has ALREADY been renamed on-chain (NameUpdated/SymbolUpdated history). Trust the address, not the label.",
    price: "$0.04",
    icon: "🪪",
    category: "B20",
    params: [{ name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true }],
    handler: b20Metadata,
    noFreeTier: true,
  },
  {
    id: "b20-permit",
    name: "B20 Permit Inspector",
    tagline: "Gasless-approval (ERC-2612) readiness for agents",
    description:
      "🆕 Every B20 has ERC-2612 permit built in — approve a spender by signature instead of a transaction. Reads exactly what an agent needs to build a valid permit: the token's DOMAIN_SEPARATOR, the owner's current nonce (so the signed payload can't be rejected/replayed), and the EIP-712 domain/type struct. Read-only — signs nothing.",
    price: "$0.03",
    icon: "🖊️",
    category: "B20",
    params: [
      { name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true },
      { name: "owner", label: "Owner wallet (for the nonce, optional)", placeholder: "0x…" },
    ],
    handler: b20Permit,
    noFreeTier: true,
  },
  {
    id: "b20-policy-admin",
    name: "B20 Policy Admin Watch",
    tagline: "WHO administers the blocklist that can freeze you?",
    description:
      "🆕 b20-control reads the token's own roles; the address that can actually add you to a blocklist lives in the Policy Registry. This reads WHO administers each active transfer/mint policy (policyAdmin), and whether that control is being handed over (pendingPolicyAdmin) or renounced. The other half of 'who can freeze/seize you', straight from the registry.",
    price: "$0.04",
    icon: "🗝️",
    category: "B20",
    params: [{ name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true }],
    handler: b20PolicyAdmin,
    noFreeTier: true,
  },
  {
    id: "b20-access-type",
    name: "B20 Access Type",
    tagline: "Permissioned (allowlist) or blockable? Decoded per scope",
    description:
      "🆕 A B20 transfer policy is either a BLOCKLIST (allowed unless listed) or an ALLOWLIST (allowed ONLY if listed — a permissioned/whitelist token you can't even receive uninvited). b20-safety flags that a policy exists; this decodes its TYPE per scope (send/receive/execute/mint) — the difference between 'the issuer can block bad actors' and 'this is a permissioned RWA you can't hold uninvited'.",
    price: "$0.03",
    icon: "🎫",
    category: "B20",
    params: [{ name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true }],
    handler: b20AccessType,
    noFreeTier: true,
  },
  {
    id: "b20-announcements",
    name: "B20 Announcements",
    tagline: "On-chain issuer notices & corporate actions",
    description:
      "🆕 B20 Asset tokens can post on-chain announcements (Announcement: id, description, uri) — issuer notices, corporate actions, redemptions — a channel ERC-20 has no equivalent for. Reads a token's announcement feed (active vs ended) from CDP-indexed events. The issuer-communications primitive for agents holding tokenized/RWA B20 assets.",
    price: "$0.03",
    icon: "📢",
    category: "B20",
    params: [{ name: "address", label: "B20 Asset token address", placeholder: "0x… B20 token", required: true }],
    handler: b20Announcements,
    noFreeTier: true,
  },
  {
    id: "b20-stablecoin",
    name: "B20 Stablecoin Profile",
    tagline: "Declared peg currency + issuance & control",
    description:
      "🆕 B20 Stablecoin tokens self-declare a fiat currency code (currency() → USD, EUR, …). Reads that declared peg alongside the issuance profile (supply, cap) and control powers (seize/freeze/pause/uncapped-mint) — a one-call 'what is this stablecoin and who controls it' for agents settling in B20 stablecoins. The currency code is the issuer's claim, not attested backing.",
    price: "$0.03",
    icon: "💵",
    category: "B20",
    params: [{ name: "address", label: "B20 Stablecoin address", placeholder: "0x… B20 token", required: true }],
    handler: b20Stablecoin,
    noFreeTier: true,
  },
  {
    id: "base-withdrawal",
    name: "Base Withdrawal Finalizer",
    tagline: "When can a Base→L1 withdrawal be finalized?",
    description:
      "🆕 Beryl (2026-06-25) cut the single-proof withdrawal window from 7 days to 5, with a dual-proof fast path at ~1 day. Given a Base withdrawal-initiation tx, this decodes the L2ToL1MessagePasser event (the withdrawalHash, target & value needed to prove/finalize on L1) and estimates the finalization windows under the post-Beryl rules. For agents managing cross-chain liquidity.",
    price: "$0.04",
    icon: "🌉",
    category: "Onchain",
    params: [{ name: "tx", label: "Base withdrawal-initiation txHash", placeholder: "0x… (64 hex)", required: true }],
    handler: baseWithdrawal,
    noFreeTier: true,
  },
  {
    id: "b20-launch-radar",
    name: "B20 Launch Radar",
    tagline: "Freshly minted B20 tokens on Base",
    description:
      "🆕 Lists the newest B20 tokens created on Base (from the B20Factory precompile) — variant, symbol, decimals, block. B20 is Base's native token standard and dozens launch hourly. A discovery feed for agents hunting new B20 launches early. Run b20-safety on any address before touching it — new ≠ safe.",
    price: "$0.01",
    icon: "📡",
    category: "B20",
    params: [{ name: "limit", label: "How many", placeholder: "12" }],
    handler: b20LaunchRadar,
    noFreeTier: true,
  },
  {
    id: "b20-policy-watch",
    name: "B20 Policy Watch",
    tagline: "Did this token BECOME seizable after launch?",
    description:
      "The B20-only rug vector: a token can launch clean and later attach a sender blocklist (PolicyUpdated) — silently becoming seizable via burnBlocked. This reads the token's full policy/pause event timeline (CDP-indexed onchain events) plus the live policy state, and tells you if — and exactly WHEN — it turned seizable.",
    price: "$0.03",
    icon: "👁️",
    category: "B20",
    params: [{ name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true }],
    handler: b20PolicyWatch,
    noFreeTier: true,
  },
  {
    id: "b20-guard",
    name: "B20 Guard",
    tagline: "Real-time alerts the moment a B20 token turns seizable",
    description:
      "The live layer over B20 Policy Watch: a network-wide onchain webhook captures every B20 PolicyUpdated/Paused sub-second. Pass a token address for its live guard status, or call with no address for the feed of tokens that JUST attached a sender blocklist (turned seizable) across all of Base.",
    price: "$0.05",
    icon: "🚨",
    category: "B20",
    params: [{ name: "address", label: "B20 token (optional — omit for network feed)", placeholder: "0x… B20 token" }],
    handler: b20Guard,
    noFreeTier: true,
  },
  {
    id: "b20-info",
    name: "B20 Token Info",
    tagline: "Full profile of a Base-native B20 token",
    description:
      "Complete B20 token profile straight from the precompile: variant (Asset/Stablecoin), name, symbol, decimals, total supply, supply cap, active transfer policies, pause states, and rebase. The data companion to b20-safety.",
    price: "$0.02",
    icon: "🪪",
    category: "B20",
    params: [{ name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true }],
    handler: b20Info,
    noFreeTier: true,
  },
  {
    id: "b20-freeze-check",
    name: "B20 Freeze Check",
    tagline: "Is YOUR wallet blocked or seizable on this B20 token?",
    description:
      "Checks whether a specific wallet is authorized under a B20 token's transfer-sender policy. If it isn't, that wallet can't transfer and can be burnBlocked() (SEIZED) by the issuer. The personal companion to b20-safety — 'can this token freeze MY funds?'",
    price: "$0.03",
    icon: "🧊",
    category: "B20",
    params: [
      { name: "token", label: "B20 token address", placeholder: "0x… B20 token", required: true },
      { name: "wallet", label: "Your wallet address", placeholder: "0x… wallet", required: true },
    ],
    handler: b20FreezeCheck,
    noFreeTier: true,
  },
  {
    id: "b20-rebase",
    name: "B20 Rebase Tracker",
    tagline: "Asset-variant rebase multiplier & scaling risk",
    description:
      "Reads a B20 Asset token's rebase multiplier — the factor that scales every holder's balance. Flags whether balances are being scaled (invisible dilution/inflation the issuer controls). Stablecoin variants return no-rebase.",
    price: "$0.02",
    icon: "🔄",
    category: "B20",
    params: [{ name: "address", label: "B20 token address", placeholder: "0x… B20 token", required: true }],
    handler: b20Rebase,
    noFreeTier: true,
  },
  {
    id: "b20-batch",
    name: "B20 Batch Safety",
    tagline: "Freeze/seize scan for up to 5 B20 tokens",
    description:
      "Runs the B20 safety verdict across up to 5 B20 tokens in one call — each scored for freeze/seize/pause/rebase/uncapped-mint, with the worst score surfaced. For portfolio holders and agents screening several B20s at once.",
    price: "$0.08",
    icon: "🗂️",
    category: "B20",
    params: [{ name: "addresses", label: "B20 addresses (comma-separated)", placeholder: "0x…, 0x…", required: true }],
    handler: b20Batch,
    noFreeTier: true,
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
  // HIDDEN until the simulation backend is replaced (Alchemy plan lacks
  // alchemy_simulateAssetChanges on Base — 'JS Tracer is not enabled').
  //   {
  //     id: "simulate-tx",
  //     name: "Transaction Simulation",
  //     tagline: "What an unsigned tx will do — before you sign it",
  //     description:
  //       "Simulate an UNSIGNED transaction against current Base state: what tokens leave/arrive for the sender, any approvals it grants (flags unlimited allowance & setApprovalForAll — the classic drain vector), whether it would revert, and gas. The pre-execution safety check every agent needs before signing.",
  //     price: "$0.03",
  //     icon: "🧪",
  //     category: "Onchain",
  //     params: [
  //       { name: "from", label: "Sender address", placeholder: "0x… sender", required: true },
  //       { name: "to", label: "To (recipient/contract)", placeholder: "0x… recipient or contract", required: true },
  //       { name: "data", label: "Calldata (hex, optional)", placeholder: "0x… (for contract calls)" },
  //       { name: "value", label: "ETH value (optional)", placeholder: "0.1" },
  //     ],
  //     handler: simulateTx,
  //     noFreeTier: true,
  //   },
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
    price: "$0.08",
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
    noFreeTier: true,
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
  // HIDDEN until the simulation backend is replaced (Alchemy plan lacks
  // alchemy_simulateAssetChanges on Base — 'JS Tracer is not enabled').
  //   {
  //     id: "pre-sign",
  //     name: "Pre-Sign Preflight",
  //     tagline: "Should your agent sign THIS transaction? One call, one verdict",
  //     description:
  //       "The go/no-go check for the instant before signing: a live simulation of the unsigned tx (what leaves, what approvals it grants, whether it reverts), a danger scan of the destination contract (owner abuse powers), and an OFAC screen of the destination — combined into a deterministic allow / caution / would_fail / block decision with reasons. The single highest-stakes moment for an autonomous agent, covered in one call.",
  //     price: "$0.08",
  //     icon: "✍️",
  //     category: "Onchain",
  //     params: [
  //       { name: "from", label: "Sender address", placeholder: "0x… sender", required: true },
  //       { name: "to", label: "To (recipient/contract)", placeholder: "0x… recipient or contract", required: true },
  //       { name: "data", label: "Calldata (hex, optional)", placeholder: "0x… (for contract calls)" },
  //       { name: "value", label: "ETH value (optional)", placeholder: "0.1" },
  //     ],
  //     handler: preSignPreflight,
  //     noFreeTier: true,
  //   },
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
      "Reads the deepest pool's 24h volume, buy/sell counts, liquidity and price move, and scores how organic the activity looks. Volume 10x+ the pool's liquidity, near-perfect buy/sell symmetry, or big volume that moves the price nowhere are the classic wash-trading signatures used to bait buyers. Returns a 0-100 suspicion score and verdict.",
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
      "Ranks a wallet's active token approvals by USD-at-risk x unlimited-allowance x unlabelled-spender, and returns a prioritised revoke queue. Approvals are the #1 drain vector; this tells an agent exactly what to revoke first.",
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
      { name: "webhook", label: "Webhook URL (optional — omit to poll)", placeholder: "https://your-endpoint" },
      { name: "dropPct", label: "Fire on liquidity drop % (default 50)", placeholder: "50" },
      { name: "check", label: "Or: monitor id to poll its status", placeholder: "abcd1234-…" },
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
    price: "$0.75",
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
      { name: "webhook", label: "Webhook URL (optional — omit to poll)", placeholder: "https://your-endpoint" },
      { name: "check", label: "Or: alert id to poll its status", placeholder: "alrt_…" },
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
    noFreeTier: true,
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
    hidden: true,
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
    hidden: true,
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
    hidden: true,
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
    noFreeTier: true,
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
    price: "$0.08",
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
    category: "Markets",
    params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
    handler: tokenInfo,
  },
  {
    id: "chain-status",
    name: "Base Chain Status",
    tagline: "Block, base fee, ETH price & transfer cost in USD",
    description:
      "Live Base chain snapshot: latest block, base fee + priority fee (Gwei), current ETH price, and the estimated USD cost of a simple ETH transfer. For agents timing or budgeting transactions.",
    price: "$0.01",
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
    price: "$0.01",
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
      "Complete ERC-20 portfolio for a Base address — every non-zero token with balance, metadata and live USD value, plus a total. Token discovery via CDP Data API (Coinbase) with Alchemy fallback; USD from DexScreener.",
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
    hidden: true,
  },
  {
    id: "ai-token-report",
    name: "AI Token Report",
    tagline: "Claude-written due-diligence verdict for a Base token",
    description:
      "The flagship report: aggregates token risk, holder concentration, price/liquidity and OFAC sanctions, then Claude synthesizes a structured verdict (avoid → favorable) with key risks and positives. One call, agent-ready intelligence you can't get free.",
    price: "$0.12",
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
      "Compress up to 16K characters of anything — articles, transcripts, email threads, reports — into 3-5 precise bullet points, one micro-payment per call. No API key, no subscription, no prompt engineering: send text=, get bullets back as clean JSON. The digest step for agent pipelines that read more than they can carry in context.",
    price: "$0.03",
    icon: "🧠",
    category: "AI",
    params: [{ name: "text", label: "Text to summarize", placeholder: "Paste an article, email, or notes…", required: true, multiline: true }],
    handler: aiSummarize,
  },
  {
    id: "ai-extract",
    name: "AI Extract",
    tagline: "Unstructured text → structured JSON, one call",
    description:
      "Turn ANY text into clean, schema-enforced JSON: pass text= plus the fields you want (fields=name,email,price,date — up to 10) and get exactly those keys back, guaranteed-valid JSON via Claude structured outputs. Add list=true to extract EVERY repeated record (invoice lines, listings, table rows) as an array. Up to 16K chars per call. Not crypto-specific — the universal parse step for agent pipelines: pages, emails, receipts, logs.",
    price: "$0.03",
    icon: "🗂️",
    category: "AI",
    params: [
      { name: "text", label: "Source text", placeholder: "Paste text containing the data…", required: true, multiline: true },
      { name: "fields", label: "Fields (comma-separated)", placeholder: "name, email, company, date" },
      { name: "list", label: "Extract all records (true/false)", placeholder: "false" },
    ],
    handler: aiExtract,
  },
  {
    id: "ai-extract-batch",
    name: "AI Extract Batch",
    tagline: "Same fields across up to 10 texts, one payment",
    description:
      "The pipeline version of ai-extract: send up to 10 documents (text1=…&text2=… or texts= with ||| separators) and one field list — get one schema-enforced JSON object per document, in order, from a single paid call. 10 extractions for $0.10 instead of 10x the per-call overhead: built for agents parsing feeds, inboxes, scrape batches and receipt piles. Up to 6K chars per document.",
    price: "$0.10",
    icon: "🗃️",
    category: "AI",
    params: [
      { name: "text1", label: "Document 1", placeholder: "First text…", required: true, multiline: true },
      { name: "text2", label: "Document 2 (optional)", placeholder: "Second text…", multiline: true },
      { name: "fields", label: "Fields (comma-separated)", placeholder: "name, email, company, date" },
    ],
    handler: aiExtractBatch,
  },
  {
    id: "ai-translate",
    name: "AI Translate",
    tagline: "Translate up to 6K chars to any language",
    description:
      "Claude-quality translation as a pay-per-call primitive: send text= (up to 6K characters) and to= any language, get only the translation back — no notes, no wrapper prose, safe to pipe straight into the next step. One USDC micro-payment per call, no API key or subscription. Built for agents localizing content, parsing foreign-language sources, or serving multilingual users.",
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
      "Generate N cryptographically-strong, url-safe random tokens server-side — session IDs, API nonces, one-time codes, coupon secrets. Pass count= for how many. A tiny paid utility for agents that need entropy without a crypto library.",
    price: "$0.01",
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
    hidden: true,
  },
  {
    id: "buy-credits",
    name: "Prepaid Credits",
    tagline: "Pay once, then call without per-request settlement",
    description:
      "Buy a prepaid balance in a single x402 settlement and get a secret credit token. Send it as the `x-credit-token` header on any paid service and each call debits its price from your balance — no per-call signature, no settlement latency. Built for agents that fire many checks a minute. Tiers: $0.25 (starter), $1, $5 (+10%), $20 (+20%). The token is shown once; balance lasts 180 days.",
    price: "$5.00",
    icon: "🎟️",
    category: "Utility",
    params: [{ name: "tier", label: "Pack: 0.25, 1, 5 or 20 (USD)", placeholder: "5" }],
    handler: buyCredits,
    noFreeTier: true,
  },
];

export function getService(id: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === id);
}
