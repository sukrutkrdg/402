/**
 * NEAR protocol intelligence, account safety, and swap preflight services
 */

import type { ServiceDef } from "./types";
import { nearAccountAge } from "../near-account-age";
import { nearAgentGate } from "../near-agent-gate";
import { nearTokenSafety } from "../near-token-safety";
import { nearAccount } from "../near-account";
import { nearTransferPreflight } from "../near-transfer-preflight";
import { nearSwapQuote } from "../near-swap-quote";
import { nearPreTradeGate } from "../near-pre-trade-gate";
import { nearPortfolio } from "../near-portfolio";
import { nearWalletActivity } from "../near-wallet-activity";
import { nearTokenHolders } from "../near-token-holders";
import { nearSwap, nearSwapStatus } from "../near-swap";
import { nearStakingYields } from "../near-staking-yields";
import { nearLendingHealth } from "../near-lending-health";

export const NEAR_SERVICES: ServiceDef[] = [
  {
      id: "near-account-age",
      name: "NEAR Account Age & Origin",
      tagline: "Is this NEAR account/agent established or a fresh throwaway?",
      description:
        "Before you trust, pay or copy a NEAR account — or one of the agents on NEAR AI's Agent Market — is it established or created minutes ago? near-account gives the current state; this gives the PROVENANCE: the creation date (age), the creator (first provenance hop), and whether it's since been deleted, from the NearBlocks indexer. Age is a first-order Sybil/trust signal — new ≠ malicious, but a fresh counterparty warrants caution. Pair with near-wallet-activity. Not financial advice.",
      price: "$0.02",
      icon: "🌱",
      category: "NEAR",
      params: [{ name: "account", label: "NEAR account id", placeholder: "name.near or 64-hex implicit", required: true }],
      handler: nearAccountAge,
    },
  {
      id: "near-agent-gate",
      name: "NEAR Agent Pay Gate",
      tagline: "Before you pay a NEAR account — will it clear, and is it safe?",
      description:
        "The NEAR counterpart of agent-pay-gate. Composes the recipient's account posture (does it exist, is it a contract, control flags) with the NEP-141 transfer preflight into one GO/HOLD/STOP before an agent sends. On NEAR a mistyped account is unrecoverable and a token transfer silently fails unless the recipient has storage_deposit — this catches both ahead of time. Pass token (+amount) for a token transfer, near= for native-amount sizing. Not financial advice.",
      price: "$0.02",
      icon: "🟢",
      category: "NEAR",
      params: [
        { name: "to", label: "NEAR account you are about to pay", placeholder: "alice.near", required: true },
        { name: "token", label: "NEP-141 token (optional)", placeholder: "usdt.tether-token.near" },
        { name: "amount", label: "Token amount (optional)", placeholder: "100" },
        { name: "near", label: "Native NEAR amount (optional, for sizing)", placeholder: "50" },
      ],
      handler: nearAgentGate,
    },
  {
      id: "near-token-safety",
      name: "NEAR Token Safety",
      tagline: "Who can change a NEAR token's contract? GO / HOLD / STOP",
      description:
        "Before an agent takes a NEP-141 token on NEAR: who can change it? Counts full-access keys that can redeploy the contract, and asks the contract for an owner and a pause switch — issued tokens like USDt keep control through owner methods, not keys. No key and no owner → GO; key- or owner-controlled → HOLD; paused, no contract or not NEP-141 → STOP. Plus name, symbol, supply, and NEAR Intents liquidity and price. Live from the NEAR RPC.",
      price: "$0.02",
      icon: "Ⓝ",
      category: "NEAR",
      params: [{ name: "token", label: "NEAR token contract account", placeholder: "usdt.tether-token.near", required: true }],
      handler: nearTokenSafety,
    },
  {
      id: "near-account",
      name: "NEAR Account Check",
      tagline: "What is this NEAR account, and who controls it?",
      description:
        "Before an agent pays or trusts a NEAR account: does it exist, what kind is it (named, implicit, 0x), how much NEAR it holds (available, staked, locked for storage), whether it is a contract or a NEP-141 token, and who controls it — full-access keys that can do anything, and function-call keys limited to one contract. Flags a wallet held by one key, a contract replaceable by key, and an account no one can sign for. Live from the NEAR RPC.",
      price: "$0.01",
      icon: "Ⓝ",
      category: "NEAR",
      params: [{ name: "account", label: "NEAR account", placeholder: "alice.near", required: true }],
      handler: nearAccount,
    },
  {
      id: "near-transfer-preflight",
      name: "NEAR Transfer Preflight",
      tagline: "Will this NEAR token transfer go through? GO / HOLD / STOP",
      description:
        "Before sending a NEP-141 token on NEAR: is the token real and not paused, does the receiver exist, and is it registered on the token — the storage_deposit step whose absence fails a transfer. If not, says the exact fix and its NEAR cost. With from and amount, also checks the sender holds enough. Catches sending to the token contract itself. Live from the NEAR RPC.",
      price: "$0.01",
      icon: "Ⓝ",
      category: "NEAR",
      params: [
        { name: "token", label: "NEAR token contract account", placeholder: "usdt.tether-token.near", required: true },
        { name: "to", label: "Receiver NEAR account", placeholder: "alice.near", required: true },
        { name: "from", label: "Sender NEAR account (optional)", placeholder: "bob.near" },
        { name: "amount", label: "Amount in token units (optional)", placeholder: "25" },
      ],
      handler: nearTransferPreflight,
    },
  {
      id: "near-swap-quote",
      name: "NEAR Intents Swap Quote",
      tagline: "What does swapping A for B through NEAR Intents give back?",
      description:
        "An indicative quote for swapping any asset NEAR Intents routes — NEAR, USDC, USDT, BTC, SOL and more, across chains. Name assets as a symbol (USDC = on NEAR, USDC@base for another chain), a NEAR token account, or a 1Click asset id. Returns amount out, minimum out, USD in and out, the rate, the cost in percent lost to fees and price impact, and the expected time. Nothing is reserved or paid.",
      price: "$0.01",
      icon: "Ⓝ",
      category: "NEAR",
      params: [
        { name: "from", label: "Asset you pay with", placeholder: "USDC", required: true },
        { name: "to", label: "Asset you want", placeholder: "NEAR", required: true },
        { name: "amount", label: "Amount of the paying asset", placeholder: "100", required: true },
      ],
      handler: nearSwapQuote,
    },
  {
      id: "near-pre-trade-gate",
      name: "NEAR Pre-Trade Gate",
      tagline: "One call before buying a NEAR token — GO / HOLD / STOP",
      description:
        "The call to make before buying a NEP-141 token: who controls it (keys, owner, pause), whether you can get back out — a USDC round trip through NEAR Intents at your trade size, loss measured — and whether a few accounts hold most of the circulating supply. Over 15% lost or no route is STOP or HOLD; HIGH concentration is HOLD. One verdict with the quotes. size is in USD (default 100).",
      price: "$0.05",
      icon: "🚦",
      category: "NEAR",
      params: [
        { name: "token", label: "NEAR token contract account", placeholder: "usdt.tether-token.near", required: true },
        { name: "size", label: "Trade size in USD (optional, default 100)", placeholder: "100" },
      ],
      handler: nearPreTradeGate,
    },
  {
      id: "near-portfolio",
      name: "NEAR Portfolio",
      tagline: "What a NEAR account holds, and what it is worth",
      description:
        "Net worth of a NEAR account: its NEAR (liquid and staked) plus balances in every NEP-141 token NEAR Intents routes with a live price — USDC, USDT, wNEAR, bridged BTC and ETH and more — each valued in USD and sorted by value, with the total. Says how many tokens were scanned; tokens outside that list are not included. Live from the NEAR RPC, priced by NEAR Intents.",
      price: "$0.02",
      icon: "Ⓝ",
      category: "NEAR",
      params: [{ name: "account", label: "NEAR account", placeholder: "alice.near", required: true }],
      handler: nearPortfolio,
    },
  {
      id: "near-wallet-activity",
      name: "NEAR Wallet Activity",
      tagline: "What has this NEAR account been doing?",
      description:
        "Recent history of a NEAR account, summed up: transactions signed and received, failures, NEAR sent and received, token flows in and out per token, the contracts it calls most, who it deals with most, and signals (inactive, failing, receive-only). One-line summary plus the last 10 transactions. Reads the NearBlocks indexer; limit sets how many recent transactions (default 25).",
      price: "$0.02",
      icon: "Ⓝ",
      category: "NEAR",
      params: [
        { name: "account", label: "NEAR account", placeholder: "alice.near", required: true },
        { name: "limit", label: "Recent transactions to read (optional, 5-50)", placeholder: "25" },
      ],
      handler: nearWalletActivity,
    },
  {
      id: "near-token-holders",
      name: "NEAR Token Holders",
      tagline: "Who holds this NEAR token, and how concentrated is it?",
      description:
        "Top holders of a NEP-141 token on NEAR with each one's share of total supply, labelled as the token itself, an issuer treasury, a contract (pool, bridge, custodian) or a plain account, so neither a pool nor unissued stock is mistaken for a whale. Holder count, shares, and LOW / MEDIUM / HIGH concentration of plain accounts over circulating supply. Supply from the NEAR RPC, holders from NearBlocks.",
      price: "$0.02",
      icon: "Ⓝ",
      category: "NEAR",
      params: [
        { name: "token", label: "NEAR token contract account", placeholder: "usdt.tether-token.near", required: true },
        { name: "top", label: "Holders to list (optional, 1-25)", placeholder: "10" },
      ],
      handler: nearTokenHolders,
    },
  {
      id: "near-swap",
      name: "NEAR Intents Swap",
      tagline: "Swap any asset through NEAR Intents — get a deposit address",
      description:
        "An executable NEAR Intents swap: a binding quote with a deposit address. Send amountIn of the origin asset there before the deadline; the output goes to recipient, or it is refunded to refundTo. Funds never pass through us. Any asset NEAR Intents routes, across chains. Buying a NEAR token runs near-token-safety first and refuses a STOP token unless force=1. Track with near-swap-status.",
      price: "$0.01",
      icon: "🔁",
      category: "NEAR",
      params: [
        { name: "from", label: "Asset you pay with", placeholder: "USDC", required: true },
        { name: "to", label: "Asset you want", placeholder: "NEAR", required: true },
        { name: "amount", label: "Amount of the paying asset", placeholder: "100", required: true },
        { name: "recipient", label: "Receiving address on the destination chain", placeholder: "alice.near", required: true },
        { name: "refundTo", label: "Your address on the origin chain (refunds)", placeholder: "alice.near", required: true },
        { name: "slippage", label: "Slippage in bps (optional, default 100)", placeholder: "100" },
        { name: "depositType", label: "INTENTS to pay from a NEAR Intents balance (optional)", placeholder: "ORIGIN_CHAIN" },
      ],
      handler: nearSwap,
    },
  {
      id: "near-swap-status",
      name: "NEAR Intents Swap Status",
      tagline: "Where is my NEAR Intents swap?",
      description:
        "Status of a NEAR Intents swap by its deposit address: waiting for deposit, deposit seen, processing, done, refunded or failed — with amounts in and out, refund reason, and the origin and destination transactions. Use after near-swap.",
      price: "$0.002",
      icon: "🔁",
      category: "NEAR",
      params: [{ name: "depositAddress", label: "Deposit address from near-swap", placeholder: "0x… or …near", required: true }],
      handler: nearSwapStatus,
    },
  {
      id: "near-staking-yields",
      name: "NEAR Staking Yields",
      tagline: "What liquid staking on NEAR really pays, measured on-chain",
      description:
        "Measured APY of NEAR liquid staking (LiNEAR, Meta Pool stNEAR): each token's redemption price in NEAR now against N days ago from an archival node, annualised — no advertised rates. Plus NEAR staked behind each, and the cost of exiting instantly by selling for wNEAR through NEAR Intents instead of waiting ~2–3 days to unstake. days sets the window (default 7), size the exit in USD.",
      price: "$0.02",
      icon: "Ⓝ",
      category: "NEAR",
      params: [
        { name: "days", label: "Window in days (optional, 1-30)", placeholder: "7" },
        { name: "size", label: "Exit size in USD (optional)", placeholder: "1000" },
      ],
      handler: nearStakingYields,
    },
  {
      id: "near-lending-health",
      name: "NEAR Lending Health",
      tagline: "How close is this Rhea Lending position to liquidation?",
      description:
        "Health factor of an account's Rhea Lending (Burrow) position on NEAR, computed as the contract does — collateral discounted and debt marked up by each asset's volatility ratio — with collateral and debt in USD, how far collateral can fall before liquidation, and GO / HOLD / STOP. Positions from the contract, prices from NEAR Intents.",
      price: "$0.02",
      icon: "🩺",
      category: "NEAR",
      params: [{ name: "account", label: "NEAR account", placeholder: "alice.near", required: true }],
      handler: nearLendingHealth,
    },
];
