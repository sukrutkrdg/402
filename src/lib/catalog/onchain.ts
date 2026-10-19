/**
 * Onchain intelligence, forensic, security, and wallet services
 */

import type { ServiceDef } from "./types";
import { addressIntel, tokenRisk } from "../onchain";
import { preTradeGate } from "../gate";
import { preTradeBundle } from "../pre-trade-bundle";
import { signGuard } from "../sign-guard";
import { spendAudit } from "../spend-audit";
import { agentWalletAudit } from "../agent-wallet-audit";
import { walletDelegation } from "../delegation";
import { commerceEscrow, commerceOperatorAudit } from "../commerce";
import { firstFunder } from "../provenance";
import { fundTrace } from "../fund-trace";
import { contractOwner, launchSnipers, washTrading } from "../onchain-forensics";
import { holderOverlap, tokenAge } from "../token-cohort";
import { addressPoisoning, sanctionedExposure } from "../wallet-forensics";
import { priceImpact } from "../price-impact";
import { dumpRisk } from "../dump-risk";
import { describeAddress } from "../address-probe";
import { ownerPowers } from "../owner-powers";
import { supplyInflation } from "../supply-inflation";
import { activityTrend } from "../activity-trend";
import { freshBridge } from "../bridge";
import { safeToSend } from "../safe-to-send";
import { addressTrust } from "../address-trust";
import { basenameProfile, basenameResolve, ensResolve } from "../basename";
import { whaleFlow } from "../whale-flow";
import { watchlistDiff } from "../watchlist";
import { gasOracle, multiTokenPrice, tokenPrice, txDecode } from "../onchain-extra";
import { baseWithdrawal } from "../base-withdrawal";
import { simulateTx } from "../tx-sim";
import { sellability } from "../sellability";
import { holderForensics } from "../holder-forensics";
import { proxyCheck } from "../proxy";
import { contractDanger } from "../contract-danger";
import { lpLock } from "../lp-lock";
import { clankerTokenAudit } from "../clanker-audit";
import { deployerReputation } from "../deployer-rep";
import { baseSwap } from "../base-swap";
import { bridgeRoute } from "../bridge-route";
import { bridgeStatus } from "../bridge-status";
import { baseSwapValidity } from "../base-swap-validity";
import { validityBuild } from "../validity-tx";
import { x402SellerCheck } from "../x402-seller";
import { agentPayGate } from "../agent-pay-gate";
import { agentReputation } from "../agent-reputation";
import { walletDrainWatch } from "../wallet-drain-watch";
import { mevGuard } from "../mev-guard";
import { knowYourAgent } from "../know-your-agent";
import { tokenUnlock } from "../token-unlock";
import { positionHealth } from "../position-health";
import { tokenCompare } from "../token-compare";
import { approvalAdvisor } from "../approval-advisor";
import { portfolioScan } from "../portfolio-scan";
import { registerRugMonitor } from "../rug-monitor";
import { trendingTokens, walletTokens } from "../onchain-extra2";
import { registerAlert } from "../alerts";
import { contractAbi, decodeSelector, encodeSelector } from "../onchain-extra3";
import { complianceCheck, sanctionsBatch, sanctionsCheck } from "../compliance";
import { holderDistribution } from "../holders";
import { rugScore } from "../scores";
import { batchRisk } from "../batch";
import { chainStatus } from "../market";
import { newTokens } from "../onchain-extra4";
import { walletNetworth, walletNfts, walletPortfolio } from "../alchemy";
import { walletSummary } from "../wallet-history";
import { tokenTransfers, walletActivity } from "../covalent";
import { tokenApprovals } from "../approvals";
import { baseBlock, baseNonce, baseReceipt, baseTx, contractInfo, tokenBalance, tokenSupply } from "../primitives";
import { walletSybilScore } from "../wallet-sybil";

export const ONCHAIN_SERVICES: ServiceDef[] = [
  {
    id: "wallet-sybil-score",
    name: "Wallet Sybil Score",
    tagline: "Is this wallet a bot or airdrop farmer?",
    description: "Evaluates a wallet address to determine if it acts like a sybil or bot based on heuristic placeholders.",
    price: "0.01",
    icon: "🤖",
    category: "onchain",
    params: [
      { name: "address", label: "Wallet Address", placeholder: "0x...", required: true }
    ],
    handler: walletSybilScore
  },
  {
      id: "token-risk",
      name: "Token Risk Check",
      tagline: "Pre-trade safety score for any Base token",
      description:
        "Use when an agent asks \"is this Base token safe?\" before buying, holding or listing it. One scam/rug check read live from Base RPC + GoPlus: honeypot, buy/sell tax, hidden or reclaimable owner, pausable transfers, blacklist, holder concentration (sellable holders only), LP lock and upgradeable proxy. Returns a 0-100 score, flags and a GO/HOLD/STOP receipt. On established tokens (50k+ holders, $1M+ liquidity) admin controls are context, not risk.",
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
        "Use before an agent buys or swaps into a Base token: token-risk, sellability (honeypot, tax), swap route and price impact for your size, and deployer reputation in one GO/HOLD/STOP verdict with a receipt. GO only when every check ran clean; an outage is HOLD. Coinbase tokenized stocks get stock checks (transfer policy, wallet eligibility, premium vs reference). GO/HOLD return `enforce`: a Cobalt condition so Base never includes your trade if the pool is drained first. Bind this tool first.",
      price: "$0.10",
      icon: "🚦",
      category: "Onchain",
      params: [
        { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
        { name: "amountUsd", label: "Trade size in USD (optional)", placeholder: "1000" },
        { name: "wallet", label: "Buyer wallet — for tokenized stocks, checks it may receive (optional)", placeholder: "0x… wallet" },
        { name: "maxLiquidityDropPct", label: "Enforce: max pool drop before the trade is refused, % (optional, default 20)", placeholder: "20" },
      ],
      handler: preTradeGate,
      noFreeTier: true,
    },
  {
      id: "pre-trade-bundle",
      name: "Pre-Trade Bundle",
      tagline: "Five pre-trade checks, one GO / HOLD / STOP",
      description:
        "Runs pre-trade-gate (risk, sellability, route, deployer), b20-gate (seize/freeze/pause; N/A for non-B20 tokens), owner-powers and dump-risk in parallel on a Base token, with clanker-token-audit as provenance that never moves the verdict. Returns GO/HOLD/STOP, what each check saw, an unverified list, a max size held to 2% impact on the exit-liquidity read, and a receipt. GO only if every applicable check ran clean; if a gating check could not run there is no GO and no charge.",
      price: "$0.15",
      icon: "🧰",
      category: "Onchain",
      params: [
        { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
        { name: "amountUsd", label: "Trade size in USD (optional)", placeholder: "1000" },
      ],
      handler: preTradeBundle,
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
      id: "fund-trace",
      name: "Fund Trace (Source of Funds)",
      tagline: "Trace a wallet's money back to a CEX, a bridge — or a sanctioned address",
      description:
        "first-funder goes one hop; this walks the funding chain back up to 8 hops to a recognisable origin (a CEX/bridge on-ramp — lower-risk provenance) OR a SANCTIONED address (dirty money, taint by provenance) OR a dead-end of fresh anon EOAs (the sybil/burner-cluster shape). One verdict compliance can refuse on. Best-effort: internal-transfer funding is invisible and ends the walk, never guessed. A CEX origin is a signal, not identity. Not financial advice.",
      price: "$0.10",
      icon: "🧵",
      category: "Onchain",
      params: [
        { name: "wallet", label: "Wallet to trace", placeholder: "0x… wallet", required: true },
        { name: "hops", label: "Max hops (default 5, max 8)", placeholder: "5" },
      ],
      handler: fundTrace,
      noFreeTier: true,
    },
  {
      id: "wash-trading",
      name: "Wash Trading Check",
      tagline: "Is this token's volume real, or circular?",
      description:
        "Hot volume is often fake. This reads a token's transfer events and flags the wash/circular shape: the share of transfers round-tripping through addresses active on BOTH the send and receive side, plus participant concentration. Returns clean / elevated / likely_wash with the top round-trippers. A heuristic signal, not proof — LPs and routers legitimately sit on both sides — so size off it, don't convict on it. Pass days= (default 7). Not financial advice.",
      price: "$0.05",
      icon: "🔄",
      category: "Onchain",
      params: [
        { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
        { name: "days", label: "Window days (default 7, max 30)", placeholder: "7" },
      ],
      handler: washTrading,
    },
  {
      id: "launch-snipers",
      name: "Launch Sniper Check",
      tagline: "Were the first buyers a coordinated bundle, or organic?",
      description:
        "Reads a token's EARLIEST transfers to judge how it was launched: many recipients in a single early block or a tight block span is a sniped/bundled launch (coordinated, expect correlated dumping); very few early holders is dangerous concentration; a spread is organic. Returns the first holders and a verdict. The launch-quality read that pairs with b20-launch-radar — a heuristic, not proof. Pass first= (default 40). Not financial advice.",
      price: "$0.05",
      icon: "🎯",
      category: "Onchain",
      params: [
        { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
        { name: "first", label: "Earliest transfers to analyse (default 40)", placeholder: "40" },
      ],
      handler: launchSnipers,
    },
  {
      id: "contract-owner",
      name: "Contract Owner",
      tagline: "Who controls this contract right now — owner, admin, proxy",
      description:
        "Reads who controls a contract straight from chain: owner/getOwner/admin, pending owner, EIP-1967 proxy implementation + admin, and paused state — and whether the owner is a single EOA key (one compromise = total control) or a contract (multisig/timelock). Crucially: ownership 'renounced' is NOT safe if it is still an upgradeable proxy whose admin can swap the logic. The control-surface read before you trust a contract. Not financial advice.",
      price: "$0.03",
      icon: "🔑",
      category: "Onchain",
      params: [{ name: "address", label: "Contract address", placeholder: "0x… contract", required: true }],
      handler: contractOwner,
    },
  {
      id: "holder-overlap",
      name: "Holder Overlap",
      tagline: "Do two tokens share a holder base? (coordinated-network signal)",
      description:
        "Do two tokens share the same recent holders — the farm / sybil / coordinated-launch signal nobody else surfaces? Reads each token's recent recipients and returns the overlap as a share of the smaller set: independent (the few % unrelated tokens share via routers/power users), overlapping, or strongly_linked (a coordinated cohort — same farm, deployer community, or a sybil set rotating between them). Pass a= and b=. A signal, not proof. Not financial advice.",
      price: "$0.05",
      icon: "🔗",
      category: "Onchain",
      params: [
        { name: "a", label: "Token A", placeholder: "0x… token", required: true },
        { name: "b", label: "Token B", placeholder: "0x… token", required: true },
      ],
      handler: holderOverlap,
    },
  {
      id: "token-age",
      name: "Token Age",
      tagline: "How old is this token? (new = higher rug risk)",
      description:
        "When was this token born — its earliest transfer on Base — and how old is it in days, with a verdict: brand_new (<1d), very_new (<7d, where most rugs happen), new (<30d), established, or mature. New is not bad, but age is a first-order risk input every agent should have before sizing. Pairs with launch-snipers and token-risk. Not a safety verdict on its own. Not financial advice.",
      price: "$0.01",
      icon: "🕰️",
      category: "Onchain",
      params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
      handler: tokenAge,
    },
  {
      id: "address-poisoning",
      name: "Address Poisoning Check",
      tagline: "Is this recipient a look-alike trap? — before your agent pays",
      description:
        "The address-poisoning attack: a scammer sends dust from an address whose first/last characters match one you really use, hoping you copy-paste the poisoned one. An auto-paying agent is the perfect victim. This compares the recipient against the head/tail of addresses the wallet actually transacts with and flags a look-alike that is NOT a real counterparty. Pass wallet= (yours) and to= (the recipient). A heuristic — verify the full address regardless. Not financial advice.",
      price: "$0.03",
      icon: "🪤",
      category: "Onchain",
      params: [
        { name: "wallet", label: "Your wallet (the sender)", placeholder: "0x… your wallet", required: true },
        { name: "to", label: "Recipient you're about to pay", placeholder: "0x… recipient", required: true },
      ],
      handler: addressPoisoning,
    },
  {
      id: "sanctioned-exposure",
      name: "Sanctioned Exposure",
      tagline: "Has this wallet dealt with an OFAC address? (taint by association)",
      description:
        "Not 'is this address sanctioned' (that's sanctions) but 'has it DEALT with one' — screens a wallet's USDC counterparties (both directions) against the OFAC SDN list. Taint by association: receiving from or routing through a wallet that transacts with sanctioned addresses carries sanctions risk. Returns the sanctioned counterparties found. Covers direct counterparties; pair with fund-trace for the multi-hop funding chain. Not financial advice.",
      price: "$0.05",
      icon: "🚫",
      category: "Onchain",
      params: [
        { name: "wallet", label: "Wallet to screen", placeholder: "0x… wallet", required: true },
        { name: "days", label: "Window days (default 90, max 365)", placeholder: "90" },
      ],
      handler: sanctionedExposure,
    },
  {
      id: "price-impact",
      name: "Price Impact",
      tagline: "How much will MY trade move the price? — size before you buy",
      description:
        "A quote shows today's price; it does NOT tell you a $5k buy into a $20k pool pays ~20% more. This takes the token's deepest Base pool, treats it as constant-product (Uniswap-V2 / Aerodrome volatile) and computes the exact x*y=k price impact for your USD size. Conservative — concentrated-liquidity pools usually do better. Also returns the largest size under 1% and 3% impact. Pass address= and size= (USD). An estimate; confirm with swap-route. Not financial advice.",
      price: "$0.03",
      icon: "📉",
      category: "Onchain",
      params: [
        { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
        { name: "size", label: "Trade size in USD", placeholder: "5000", required: true },
        { name: "side", label: "buy or sell (default buy)", placeholder: "buy" },
      ],
      handler: priceImpact,
    },
  {
      id: "dump-risk",
      name: "Dump Risk (Exit Liquidity)",
      tagline: "If the big holders sell, can liquidity absorb it?",
      description:
        "\"Top holder owns 18%\" means nothing without: 18% of what, against how deep a pool. Values the largest live holders' bags (GoPlus % × Base supply × price; pools, lending, bridges, vaults, lockers, burn excluded; exchanges reported apart) and dumps them through every Base pool the token is in, constant-product. Impact if the top holder and top 3 exit; verdict resilient → exit_trap. USD stablecoins: not_applicable (see stablecoin-peg). Heuristic; not financial advice.",
      price: "$0.04",
      icon: "🏃",
      category: "Onchain",
      params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
      handler: dumpRisk,
    },
  {
      id: "address-label",
      name: "Address Label (What Is This Base Address?)",
      tagline: "Protocol, exchange, bridge, locker — or just a wallet?",
      description:
        "What is this Base address? Matches a sourced registry of known protocol, exchange, bridge, locker and burn addresses (each with the docs/deployments/Basescan source it came from), then reads the chain: contract vs EOA (EIP-7702 delegation shown), ERC-4626 vault (asset()), Safe multisig (getThreshold), DEX pool interface (token0/token1). Unmatched addresses are reported as unlabelled, never guessed.",
      price: "$0.005",
      icon: "🏷️",
      category: "Onchain",
      params: [{ name: "address", label: "Base address to identify", placeholder: "0x… any address", required: true }],
      handler: describeAddress,
    },
  {
      id: "owner-powers",
      name: "Owner Powers (Latent Rug Surface)",
      tagline: "What can the owner do to you AFTER you buy?",
      description:
        "A token can look clean now — low tax, no honeypot, sells fine — and still leave the owner holding the switches to trap you later. sellability asks 'can I sell today'; this asks 'what can the owner do AFTER I buy'. Lists the mutable owner powers — raise sell tax to 100%, zero your balance, blacklist you, pause transfers, reclaim 'renounced' ownership, mint supply — each mapped to the attack it enables, plus whether a renounce is real. Not financial advice.",
      price: "$0.03",
      icon: "🎛️",
      category: "Onchain",
      params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
      handler: ownerPowers,
    },
  {
      id: "supply-inflation",
      name: "Supply Inflation",
      tagline: "Not 'can it mint' — is it minting, and how fast?",
      description:
        "owner-powers says the owner CAN mint; this says whether they ARE, and how fast. A token can advertise fixed supply and quietly inflate it, diluting holders before the dump. Sums zero-address mints and burns over a window (CDP SQL) against live on-chain totalSupply, annualised. Verdict from fixed_in_window / deflationary to hyperinflation. Honest: bridges, staking and LP programs mint legitimately — flags the RATE, not intent. Not financial advice.",
      price: "$0.03",
      icon: "🖨️",
      category: "Onchain",
      params: [
        { name: "address", label: "Token contract address", placeholder: "0x… token", required: true },
        { name: "days", label: "Window days (default 30, max 45)", placeholder: "30" },
      ],
      handler: supplyInflation,
    },
  {
      id: "activity-trend",
      name: "Activity Trend (Adoption)",
      tagline: "Is the token gaining or losing on-chain users?",
      description:
        "Not price momentum — ADOPTION. token-age tells you when a token was born; holder-distribution is a snapshot. Neither shows the TRAJECTORY. A token can pass every static check and still bleed users week over week — what a human sees watching for days, an agent can't. Reads weekly transfer counts and distinct participants over the last 28 days and calls it: accelerating, steady, cooling, dying, or low_activity. Activity ≠ price; pair with wash-trading. Not financial advice.",
      price: "$0.03",
      icon: "📈",
      category: "Onchain",
      params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
      handler: activityTrend,
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
      id: "safe-to-send",
      name: "Safe to Send",
      tagline: "Is this address safe to send, approve or sign to?",
      description:
        "Before your agent sends, approves or signs to an address — a wallet risk check with one GO/REVIEW/STOP verdict. Screens OFAC sanctions, Coinbase/Basename identity, wallet vs contract, how long the address has existed, and whether contract logic can be swapped AFTER you send. Every factor returns what it found and what it could not read — a check that did not run never reads as clean, so GO means everything material was actually screened. Not financial advice.",
      price: "$0.03",
      icon: "🛡️",
      category: "Onchain",
      params: [{ name: "address", label: "Address you are about to send to", placeholder: "0x… recipient", required: true }],
      handler: safeToSend,
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
      tagline: "Will this tx succeed, what will it cost, is it a drain — before you sign",
      description:
        "Simulate an UNSIGNED transaction against live Base state before an agent signs: will it SUCCEED or revert (with the contract's own reason), the gas estimate and ETH cost, and — decoded from the calldata — whether it grants an approval, and whether that approval is UNLIMITED (approve/permit) or a setApprovalForAll, the classic drain vectors. Pass from, to, and optionally data (calldata) + value. The pre-execution check the agent-safety playbook says to run and block on. Not financial advice.",
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
    },
  {
      id: "sellability",
      name: "Sellability Check",
      tagline: "Can you actually SELL it — or is it a honeypot?",
      description:
        "Use when an agent must know it can SELL a Base token before it buys: the honeypot check, answered three ways. Security simulation (honeypot, cannot-sell-all, sell/buy tax, pausable transfers), a live transfer simulation we run ourselves from a real holder (does it revert, is it taxed?), and exit liquidity. Returns a hard canSell verdict with reasons. Selling is where rugs hide.",
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
      id: "clanker-token-audit",
      name: "Clanker Launch Verification",
      tagline: "Was this Base token really launched through Clanker?",
      description:
        "Reads the deployment records of Clanker's own factories on Base (v4 tokenDeploymentInfo, v3.1/v3/v2 deploymentInfoForToken; v0/v1 via the factory's TokenCreated in the deploy receipt) to verify a launch: version, factory, requester, pool, and whether the LP position NFTs are held by Clanker's locker. Cross-checked with clanker.world. Returns clanker_verified, not_clanker or unknown; RPC failure is not charged.",
      price: "$0.03",
      icon: "🤖",
      category: "Onchain",
      params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
      handler: clankerTokenAudit,
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
      id: "base-swap",
      name: "Base Swap",
      tagline: "Swap on Base at the best price — a ready-to-sign transaction",
      description:
        "An executable swap on Base, routed by 0x across Uniswap, Aerodrome, Balancer, Curve and more. Returns the transaction for your own wallet to sign, plus the approval step if needed, minimum out, route and fees. We never hold funds. Name tokens as ETH, USDC, WETH, cbBTC, AERO… or a 0x address; buying an unknown token runs a sellability check first and refuses a honeypot unless force=1.",
      price: "$0.01",
      icon: "🔁",
      category: "Onchain",
      params: [
        { name: "sell", label: "Token you sell", placeholder: "USDC", required: true },
        { name: "buy", label: "Token you buy", placeholder: "ETH", required: true },
        { name: "amount", label: "Amount you sell", placeholder: "100", required: true },
        { name: "taker", label: "Your wallet (signs the swap)", placeholder: "0x…", required: true },
        { name: "slippage", label: "Slippage in bps (optional, default 100)", placeholder: "100" },
      ],
      handler: baseSwap,
    },
  {
      id: "bridge-route",
      name: "Cross-Chain Bridge Route",
      tagline: "The safe route to move funds across chains — best bridge, fees, ready tx",
      description:
        "Agents bridge across chains and get it wrong — bad route, an untrusted bridge, fees that eat the transfer. Returns the best cross-chain route via the LiFi aggregator: which bridge, how much arrives, est. time, gas + bridge fees in USD, and the ready-to-send tx. Chains: ethereum, base, arbitrum, optimism, polygon. Tokens by symbol (USDC/USDT/ETH/WETH/DAI) or a 0x address + amountUnits. A quote — re-quote with your own sender before executing; we never hold keys. Not financial advice.",
      price: "$0.02",
      icon: "🌉",
      category: "Onchain",
      params: [
        { name: "from", label: "From chain", placeholder: "base", required: true },
        { name: "to", label: "To chain", placeholder: "arbitrum", required: true },
        { name: "token", label: "Token symbol (default USDC)", placeholder: "USDC" },
        { name: "amount", label: "Amount to bridge", placeholder: "100", required: true },
        { name: "fromAddress", label: "Your wallet (optional, for a ready tx)", placeholder: "0x…" },
      ],
      handler: bridgeRoute,
    },
  {
      id: "bridge-status",
      name: "Bridge Status Tracker",
      tagline: "Did the cross-chain transfer land? Track it by source tx hash",
      description:
        "The other half of bridge-route. A bridge takes minutes with funds in flight, and from the source chain alone an agent cannot tell if it completed. Tracks a transfer by its source tx hash via the LiFi status API: completed (with the receiving tx), pending (poll again), failed (with the reason), or not-found (not a bridge tx, or too early to index). Pass from/to/bridge for a faster lookup. not-found reads as 'not indexed yet', never 'failed'. Not financial advice.",
      price: "$0.01",
      icon: "📦",
      category: "Onchain",
      params: [
        { name: "txHash", label: "Source-chain tx hash", placeholder: "0x… 32-byte hash", required: true },
        { name: "from", label: "From chain (optional)", placeholder: "base" },
        { name: "to", label: "To chain (optional)", placeholder: "arbitrum" },
      ],
      handler: bridgeStatus,
    },
  {
      id: "base-swap-validity",
      name: "Base Swap — Conditional",
      tagline: "A swap that lands only when your conditions hold (Cobalt validity tx)",
      description:
        "The base-swap 0x trade as a Cobalt validity transaction: Base includes your signed tx only while your conditions hold — a conditional order with no limit-order contract and nobody holding the trade. We never hold funds or keys; you sign and submit. Every request carries the deadline Base requires (at most 60 s out; set for you if omitted). Optional conditions: fromBlock, flashblockIndex (1-10), minNativeBalanceWei, or a caller-supplied storage predicate for price.",
      price: "$0.02",
      icon: "⏱️",
      category: "Onchain",
      params: [
        { name: "sell", label: "Token you sell", placeholder: "USDC", required: true },
        { name: "buy", label: "Token you buy", placeholder: "ETH", required: true },
        { name: "amount", label: "Amount you sell", placeholder: "100", required: true },
        { name: "taker", label: "Your wallet (signs the swap)", placeholder: "0x…", required: true },
        { name: "beforeBlock", label: "Deadline block (optional; at most 60 s out, set for you if omitted)", placeholder: "e.g. current block + 25" },
        { name: "fromBlock", label: "Earliest block (optional)", placeholder: "0" },
        { name: "flashblockIndex", label: "Flashblock index 1-10 (optional)", placeholder: "e.g. 1" },
        { name: "minNativeBalanceWei", label: "Min taker ETH balance in wei (optional)", placeholder: "0x…" },
        { name: "slippage", label: "Slippage in bps (optional, default 100)", placeholder: "100" },
        { name: "storageAddress", label: "Advanced: pool/token for a storage condition", placeholder: "0x…" },
        { name: "storageSlot", label: "Advanced: storage slot (hex)", placeholder: "0x…" },
        { name: "storageOp", label: "Advanced: operator (< <= = != > >=)", placeholder: ">=" },
        { name: "storageValue", label: "Advanced: compare value (hex)", placeholder: "0x…" },
        { name: "storageMask", label: "Advanced: mask (hex, optional)", placeholder: "0x…" },
      ],
      handler: baseSwapValidity,
    },
  {
      id: "validity-build",
      name: "Validity Transaction Builder",
      tagline: "Make any signed Base transaction conditional (Cobalt)",
      description:
        "Make any signed Base transaction conditional (Cobalt validity tx): Base includes it only while your conditions hold. We validate the predicates and return the base_sendRawTransactionValidity request; we never touch funds or keys. Every request carries the deadline Base requires (at most 60 s out; set for you if omitted). Optional conditions: fromBlock, flashblockIndex (1-10), minNativeBalanceWei, or a storage predicate for price.",
      price: "$0.01",
      icon: "⏱️",
      category: "Onchain",
      params: [
        { name: "beforeBlock", label: "Deadline block (optional; at most 60 s out, set for you if omitted)", placeholder: "e.g. current block + 25" },
        { name: "fromBlock", label: "Earliest block (optional)", placeholder: "0" },
        { name: "flashblockIndex", label: "Flashblock index 1-10 (optional)", placeholder: "e.g. 1" },
        { name: "flashblockIndexOp", label: "Flashblock operator (optional, default =)", placeholder: "=" },
        { name: "minNativeBalanceWei", label: "Min ETH balance floor, wei (optional)", placeholder: "0x…" },
        { name: "balanceAddress", label: "Account for the balance floor (optional)", placeholder: "0x…" },
        { name: "signedTx", label: "Your signed serialized tx (optional)", placeholder: "0x… (omit for a placeholder)" },
        { name: "storageAddress", label: "Advanced: pool/token for a storage condition", placeholder: "0x…" },
        { name: "storageSlot", label: "Advanced: storage slot (hex)", placeholder: "0x…" },
        { name: "storageOp", label: "Advanced: operator (< <= = != > >=)", placeholder: ">=" },
        { name: "storageValue", label: "Advanced: compare value (hex)", placeholder: "0x…" },
        { name: "storageMask", label: "Advanced: mask (hex, optional)", placeholder: "0x…" },
      ],
      handler: validityBuild,
    },
  {
      id: "x402-seller-check",
      name: "x402 Seller Check",
      tagline: "Before your agent pays an x402 endpoint — is the seller real?",
      description:
        "x402 proves payment, not trust: an agent handed a URL pays blind, and the payee may be a real service or a burner that takes the USDC and vanishes. Give a url and/or a payTo wallet and get GO/WARN/STOP: is the URL a well-formed 402 resource, does its price match, and is the seller wallet sanctioned, a fresh throwaway, or paying a different address than you expected. Screens the PAYMENT side the protocol drops — not a guarantee the service returns good data.",
      price: "$0.04",
      icon: "🛡️",
      category: "Onchain",
      params: [
        { name: "url", label: "x402 endpoint URL", placeholder: "https://…/api/x402/…" },
        { name: "payTo", label: "Seller wallet (optional if url given)", placeholder: "0x…" },
      ],
      handler: x402SellerCheck,
    },
  {
      id: "agent-pay-gate",
      name: "Agent Pay Gate",
      tagline: "I'm about to pay 0x… $X — go? (amount-aware recipient screen)",
      description:
        "A pre-payment gate for an agent about to send USDC. Screens the recipient (OFAC sanctions, Coinbase/Basename identity, wallet vs contract, fresh-address age) and escalates a fresh or anonymous recipient to STOP once the amount is material — a few cents to a new address is sampling, real size to one is the drain to avoid. Pass usd= for amount-aware guidance. One verdict (GO/REVIEW/STOP). Identity is not intent; not financial advice.",
      price: "$0.01",
      icon: "🚦",
      category: "Onchain",
      params: [
        { name: "to", label: "Address you are about to pay", placeholder: "0x…", required: true },
        { name: "usd", label: "Amount in USD (optional, sharpens the verdict)", placeholder: "100" },
      ],
      handler: agentPayGate,
    },
  {
      id: "agent-reputation",
      name: "Agent Reputation",
      tagline: "Is this payer a real repeat customer, or a one-shot sampler?",
      description:
        "The payer-trust mirror of x402-seller-check. Reads a wallet's outgoing USDC payments on Base over 90 days: distinct sellers paid (breadth), total payments and USDC (depth), and whether it ever paid the same payee twice. Breadth with no depth in a short burst is the crawler/sampler pattern; a repeat or sustained payer is the opposite. Sees only Base USDC; absence reads as 'thin', never bad. Not financial advice.",
      price: "$0.03",
      icon: "🪪",
      category: "Onchain",
      params: [{ name: "wallet", label: "Agent/payer wallet", placeholder: "0x…", required: true }],
      handler: agentReputation,
    },
  {
      id: "wallet-drain-watch",
      name: "Wallet Drain Watch",
      tagline: "The three ways an agent wallet gets emptied, in one verdict",
      description:
        "One GO/REVIEW/STOP across every drain vector: EIP-7702 delegation (a hostile delegate is total takeover), Base Account spend permissions (unbounded, non-expiring pulls), and ERC-20 approvals (unlimited allowance to unknown spenders). Composes wallet-delegation + spend-audit + approval-advisor so an agent checks its whole surface in one call instead of three; drill into each vector for detail. A vector that could not be read is 'unknown', never clear. Not financial advice.",
      price: "$0.06",
      icon: "🩸",
      category: "Onchain",
      params: [{ name: "wallet", label: "Wallet to scan", placeholder: "0x…", required: true }],
      handler: walletDrainWatch,
    },
  {
      id: "mev-guard",
      name: "MEV / Sandwich Guard",
      tagline: "How exposed is this swap to a sandwich — and how to land it safely",
      description:
        "Agents are the easiest MEV prey: predictable, public-mempool, a measured ~$50M/quarter tax. A sandwich only pays when a trade moves the pool enough to front-run (size vs pool depth). This returns an exposure read (low/elevated/high) and a protected-execution plan: a tight min-out, private/off-mempool inclusion (a Cobalt validity tx via validity-build), and splitting a large order into unattackable chunks. Pass tokenOut + amountUsd. Not financial advice.",
      price: "$0.04",
      icon: "🥪",
      category: "Onchain",
      params: [
        { name: "tokenOut", label: "Token you want to buy", placeholder: "0x…", required: true },
        { name: "amountUsd", label: "Trade size in USD", placeholder: "1000" },
      ],
      handler: mevGuard,
    },
  {
      id: "know-your-agent",
      name: "Know Your Agent (KYA)",
      tagline: "Who is this agent wallet — the identity half of agent trust",
      description:
        "x402 proves payment; this answers whether the wallet should be recognised. Resolves a wallet's onchain identity — Coinbase verification (a KYC'd attestation), Basename, and an ERC-8004 registry entry when configured — and corroborates with its payment track record. One verdict: recognised / named / anonymous / unknown. The identity leg alongside x402-seller-check (endpoint) and agent-reputation (behaviour). Identity is not intent; a degraded read is 'unknown'. Not financial advice.",
      price: "$0.04",
      icon: "🪆",
      category: "Onchain",
      params: [{ name: "agent", label: "Agent wallet", placeholder: "0x…", required: true }],
      handler: knowYourAgent,
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
        "Pay once to watch a Base token's liquidity. We snapshot a baseline and, every 10 minutes, POST your webhook if liquidity collapses (a liquidity pull — the actual moment of a rug). Not price moving — the pool being drained out from under you. Deliveries are HMAC-signed (secret returned once at registration) and retried up to 3 times. Expires after 30 days.",
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
      tagline: "What is trending on Base DEXes right now",
      description:
        "Use when an agent hunts what is moving on Base. Up to 15 trending Base pools ranked by live DEX activity (GeckoTerminal): token address, pool, DEX, price, 24h change, volume, liquidity and trade count. Paid DexScreener promotions are listed separately, never mixed in. Trending is not safety: vet with token-risk before buying.",
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
        "Pay once to register a price-threshold alert on any Base token. Supply target price, direction (above/below), and an https webhook URL. A cron checks DexScreener every 10 minutes and POSTs your webhook when it crosses — HMAC-signed (secret returned once at registration), retried up to 3 times. Expires after 30 days. Or omit the webhook and poll with check=<id>: the verdict is THRESHOLD_MET, ok, FIRED, or unknown when the price feed could not be read.",
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
        "Use before an agent pays, receives from or onboards a wallet: an OFAC sanctions / AML screen of the address against the US Treasury SDN list of sanctioned digital-currency addresses. Direct-address match with a GO/STOP receipt, for compliance agents and payment bots that must screen counterparties before transacting. For many addresses at once use sanctions-batch; for a person or company name use sanctions-name. No API key.",
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
      id: "rug-score",
      name: "Rug Probability Score",
      tagline: "One 0-100 risk gate (security + holders + liquidity)",
      description:
        "Use when a trading agent wants one number for \"will this Base token rug?\": a deterministic 0-100 rug-pull probability from security flags (honeypot, tax, owner powers), holder concentration, LP lock and liquidity depth, with the exact signals that drove it and the sources that did not answer. Higher = riskier; a missing feed reads unknown, never low.",
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
        "Complete token portfolio for a Base address with USD values: every ERC-20 the wallet holds, priced from live DEX liquidity, plus native ETH — sorted by value with a total. Holdings nobody quotes are listed and counted separately rather than silently valued at zero.",
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
        "Wallet age in days, first & last activity timestamps, and outgoing transaction count for any Base address — read straight from the Base archive, not a 30-day feed, so it dates wallets of any age. Counts and last-activity cover what the wallet SENT; inbound transfers don't raise the nonce and aren't counted. Built for sybil screening and counterparty trust checks.",
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
      // Unhidden 2026-09-04. It was hidden on 2026-08-01 with the rest of the
      // GoldRush/Covalent casualties, but unlike them it survives the outage: it
      // prices what it can and returns the rest as `unpricedTokens` with
      // `degraded: true`, which is an answer rather than a failure. Verified paid
      // against production on 2026-09-04 — 200, full schema. The hiding was
      // collateral damage from a batch decision that never got re-checked.
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
      // Diagnosed and unhidden 2026-09-04. The 502 was real and the note above was
      // right that the key was fine — Alchemy gates `excludeFilters` behind its
      // paid tier and refuses the whole call on the free one, which is why
      // nft-floor worked on the same key and this did not. It took making the
      // handler log its own errors to see: Cloudflare replaces the body of any 5xx
      // with a gateway page, so the message never reached anyone. The handler now
      // retries without the filter and says `spamFiltered: false`. Verified paid
      // against production — 200, 30 collections.
    },
  {
      id: "base-block",
      name: "Base Block",
      tagline: "Any Base block, by number, hash or tag",
      description:
        "🆕 One block on Base — height, hash, parent, timestamp and age in seconds, transaction count, gas used against the limit, and the base fee in gwei. Takes a block number, a 0x… block hash, or latest / finalized / safe / earliest. A block that isn't mined yet answers found:false with the reason rather than an error. Raw chain data, no interpretation.",
      price: "$0.002",
      icon: "🧱",
      category: "Onchain",
      params: [{ name: "block", label: "Block number, hash, or tag (default latest)", placeholder: "latest" }],
      handler: baseBlock,
    },
  {
      id: "base-tx",
      name: "Base Transaction",
      tagline: "A transaction exactly as the chain has it",
      description:
        "🆕 A Base transaction by hash, unedited: from, to, value in wei and ETH, nonce, gas, fee caps, type, and the 4-byte method selector with the calldata size. Flags a contract creation (null to) and a still-pending transaction (null block) rather than leaving you to infer either. Unknown hashes answer found:false, not an error.",
      price: "$0.002",
      icon: "📄",
      category: "Onchain",
      params: [{ name: "hash", label: "Transaction hash", placeholder: "0x… 32-byte tx hash", required: true }],
      handler: baseTx,
    },
  {
      id: "base-receipt",
      name: "Base Receipt",
      tagline: "Did it succeed, what did it cost, what did it touch",
      description:
        "🆕 The receipt for a Base transaction: success or reverted, block, gas used, effective gas price, the fee in wei and ETH, how many logs it emitted and which contracts emitted them. A contract deployment reports the new address. No receipt yet means pending, dropped, or never here — and it says which is possible instead of failing.",
      price: "$0.002",
      icon: "🧾",
      category: "Onchain",
      params: [{ name: "hash", label: "Transaction hash", placeholder: "0x… 32-byte tx hash", required: true }],
      handler: baseReceipt,
    },
  {
      id: "base-nonce",
      name: "Address Nonce",
      tagline: "How many transactions has this address sent?",
      description:
        "🆕 The next nonce for any Base address, plus its ETH balance and whether it is a contract. The count means different things either side of that line — transactions sent for a wallet, contracts deployed for a contract — so both are reported under their own name instead of one ambiguous number. What you need before building a transaction, or to tell a fresh address from a used one.",
      price: "$0.002",
      icon: "🔢",
      category: "Onchain",
      params: [{ name: "address", label: "Address", placeholder: "0x… wallet or contract", required: true }],
      handler: baseNonce,
    },
  {
      id: "token-balance",
      name: "Token Balance",
      tagline: "One wallet's balance of one token",
      description:
        "🆕 An ERC-20 balance on Base, in raw units and in decimals, with the token's symbol and decimals resolved in the same call. Zero is flagged explicitly, since it is the commonest answer and the one most easily confused with a failed read. An address that doesn't implement balanceOf answers found:false and says so.",
      price: "$0.002",
      icon: "🪙",
      category: "Onchain",
      params: [
        { name: "token", label: "Token contract", placeholder: "0x… token", required: true },
        { name: "wallet", label: "Wallet address", placeholder: "0x… holder", required: true },
      ],
      handler: tokenBalance,
    },
  {
      id: "token-supply",
      name: "Token Supply",
      tagline: "Total supply, in units you can actually use",
      description:
        "🆕 totalSupply for any Base token, returned raw and scaled by its decimals, alongside the name and symbol. When a contract doesn't declare decimals the answer assumes 18 and marks that it assumed — a silent guess here quietly moves every downstream number by orders of magnitude. Non-token addresses answer found:false.",
      price: "$0.002",
      icon: "📦",
      category: "Onchain",
      params: [{ name: "token", label: "Token contract", placeholder: "0x… token", required: true }],
      handler: tokenSupply,
    },
  {
      id: "contract-info",
      name: "Contract Identity",
      tagline: "Is it a contract, and what standard does it follow?",
      description:
        "🆕 What sits at a Base address: contract or plain wallet, and if a contract, whether it declares ERC-721 or ERC-1155 via ERC-165 or carries the ERC-20 shape, plus name, symbol, decimals and code size. Interface support is read from the contract's own declaration first and only inferred when there is none — the ordering matters, because NFTs answer totalSupply() too.",
      price: "$0.002",
      icon: "🔖",
      category: "Onchain",
      params: [{ name: "address", label: "Contract address", placeholder: "0x… contract", required: true }],
      handler: contractInfo,
    },
];
