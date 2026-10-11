/**
 * AI-powered analysis, synthesis, translation, and structured data extraction services
 */

import type { ServiceDef } from "./types";
import { aiContractRisk, aiDeepDueDiligence, aiMarketBrief, aiTokenReport, aiTxExplain, aiWalletReport, aiWalletSecurity } from "../ai-report";
import { aiExtract, aiExtractBatch, aiSummarize, aiTranslate } from "../ai";
import { agentProvenance } from "../agent-provenance";
import { agentCreditScore } from "../agent-credit-score";
import { agentFullAudit } from "../agent-full-audit";
import { agentSessionGuard } from "../session-guard";
import { farcasterSocialVelocity } from "../farcaster-velocity";

export const AI_SERVICES: ServiceDef[] = [
  {
      id: "deep-dd",
      name: "Deep Due-Diligence",
      tagline: "Institutional-grade full report on a Base token — one call",
      description:
        "The premium flagship. One call runs the FULL battery — contract risk, holder concentration, liquidity depth, EXIT liquidity (can you actually sell), OFAC sanctions — and AI synthesizes an institutional verdict: safety score, explicit buy/sell tradeability, liquidity & holder assessments, factors, risks, positives and a recommendation. The value is the orchestration + AI synthesis you can't get in one call anywhere else.",
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
      id: "ai-wallet-report",
      name: "AI Wallet Report",
      tagline: "AI-written verdict on any wallet",
      description:
        "The flagship wallet report: aggregates net worth, age/activity and recent transactions, then AI synthesizes a verdict (e.g. fresh/risky → established/active) with key observations. One call, agent-ready wallet intelligence.",
      price: "$0.06",
      icon: "🧠",
      category: "AI",
      params: [{ name: "address", label: "Wallet address", placeholder: "0x… wallet", required: true }],
      handler: aiWalletReport,
      // Unhidden 2026-09-04, same batch decision as token-approvals and the same
      // correction: it composes several reads and the Covalent-backed ones are not
      // load-bearing, so the report still answers. Verified paid against
      // production — 200, verdict + summary + observations present.
    },
  {
      id: "ai-token-report",
      name: "AI Token Report",
      tagline: "AI-written due-diligence verdict for a Base token",
      description:
        "The flagship report: aggregates token risk, holder concentration, price/liquidity and OFAC sanctions, then AI synthesizes a structured verdict (avoid → favorable) with key risks and positives. One call, agent-ready intelligence you can't get free.",
      price: "$0.12",
      icon: "🔬",
      category: "AI",
      params: [{ name: "address", label: "Token contract address", placeholder: "0x… token", required: true }],
      handler: aiTokenReport,
    },
  {
      id: "ai-market-brief",
      name: "AI Market Brief",
      tagline: "AI-written situational brief of the Base token market",
      description:
        "The zoom-out flagship: aggregates trending and newly-listed Base tokens, then AI writes a concise market brief — mood, highlights, new & notable launches, and cautions (fresh/unknown tokens flagged for rug risk). One call gives a trading agent market context instead of dozens of lookups.",
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
        "Pulls a wallet's active token approvals and AI writes a security audit: overall risk level, USD at risk, and concrete revoke recommendations (which token/spender and why). The wallet-safety check agents and users run before trusting an address.",
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
        "Give a Base transaction hash and AI explains what it actually did in plain English — the action, a risk read (failed tx, risky approval, high-value transfer), and notes. Turns raw calldata into an answer agents and humans can use.",
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
        "Combines security flags with the verified ABI's function names, then AI explains the contract's dangerous capabilities — owner can mint, pause, blacklist, upgrade or self-destruct — with a danger level. Goes beyond raw flags to read what the contract can actually do.",
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
        "Turn ANY text into clean, schema-enforced JSON: pass text= plus the fields you want (fields=name,email,price,date — up to 10) and get exactly those keys back, guaranteed-valid JSON via structured outputs. Add list=true to extract EVERY repeated record (invoice lines, listings, table rows) as an array. Up to 16K chars per call. Not crypto-specific — the universal parse step for agent pipelines: pages, emails, receipts, logs. Many documents? ai-extract-batch: 10 in one call for $0.10.",
      // Raised from $0.03 on 2026-08-20. list=true can return every row of a 16K
      // document, and at the output budget that needs, the model cost alone ran to
      // ~$0.044 — selling it below cost. The batch endpoint is now the cheap path
      // for volume, which is where it should have pointed all along.
      price: "$0.05",
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
        "LLM-quality translation as a pay-per-call primitive: send text= (up to 6K characters) and to= any language, get only the translation back — no notes, no wrapper prose, safe to pipe straight into the next step. Priced by length: $0.03 to 2,000 characters, $0.08 above — the 402 challenge quotes the price for the text you sent. No API key or subscription. Built for agents localizing content, parsing foreign-language sources, or serving multilingual users.",
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
      id: "agent-provenance",
      name: "AI Agent Provenance & Verification",
      tagline: "Verify autonomous AI agents on Base — Virtuals, AgentKit, EIP-7702",
      description:
        "🆕 Before paying, trading with, or copying an onchain agent: Is it an authenticated autonomous AI agent (Virtuals Protocol agent, Coinbase AgentKit, or EIP-7702 delegated wallet), or an unverified human EOA / sybil address? Inspects bytecode, delegation designators, transaction history, and agent framework markers to return a structured safety score and verdict. Pass address= (agent address).",
      price: "$0.03",
      icon: "🤖",
      category: "AI",
      params: [
        { name: "address", label: "Agent address to verify", placeholder: "0x… wallet", required: true },
      ],
      handler: agentProvenance,
    },
  {
      id: "agent-credit-score",
      name: "Agent Credit Score & FICO",
      tagline: "Onchain credit score, trust tier, and postpaid credit limit for AI agents",
      description:
        "🆕 Evaluates an onchain AI agent's transaction history, solvency, ETH/USDC reserves, and Builder Code activity to compute a FICO-style credit score (300-850), trust tier (AAA to F), and approved postpaid micro-credit limit on Base. Eligible agents qualify for batch-settled zero-latency API calls and EAS onchain attestations. Pass address= (agent wallet or contract).",
      price: "$0.04",
      icon: "💳",
      category: "AI",
      params: [
        { name: "address", label: "Agent address to score", placeholder: "0x… agent wallet", required: true },
      ],
      handler: agentCreditScore,
    },
  {
      id: "agent-full-audit",
      name: "AI Agent Full Forensic Audit",
      tagline: "Comprehensive provenance, solvency, wash-trading, and safety audit",
      description:
        "🆕 Institutional due-diligence for autonomous agents: runs provenance (Virtuals/AgentKit/EIP-7702), financial solvency & credit rating, wash trading / circular transaction detection, and control permissions in one composite call. Collapses the agent risk stack into one verified verdict: VERIFIED_AUTONOMOUS, CONTROLLED_OPERATOR, or HIGH_RISK_BOT. Pass address= (agent address).",
      price: "$0.06",
      icon: "🛡️",
      category: "AI",
      params: [
        { name: "address", label: "Agent address to audit", placeholder: "0x… agent address", required: true },
      ],
      handler: agentFullAudit,
    },
  {
      id: "agent-session-guard",
      name: "Agent Session Key & Delegate Guard",
      tagline: "Audit sub-agent session keys, spend caps, and wildcard drain vectors",
      description:
        "🆕 Pre-execution security audit for autonomous agent session keys (ERC-4337) and delegated signers (EIP-7702). Evaluates time-locks (perpetual leak vs bounded session), per-tx spend caps, router target allowlisting (Uniswap/Aerodrome vs unbounded execution), and produces an actionable GO / OVER_PERMISSIVE / DRAIN_RISK verdict before signing. Pass signer= (session key address).",
      price: "$0.03",
      icon: "🔐",
      category: "AI",
      params: [
        { name: "signer", label: "Session key / delegate address", placeholder: "0x… session signer", required: true },
        { name: "account", label: "Agent smart account (optional)", placeholder: "0x… agent wallet" },
        { name: "allowedTargets", label: "Comma-separated target contracts (optional)", placeholder: "0x…, 0x…" },
        { name: "spendCapUsd", label: "Spending limit in USD (optional)", placeholder: "100" },
        { name: "expiryHours", label: "Session lifetime hours (optional)", placeholder: "24" },
      ],
      handler: agentSessionGuard,
    },
  {
      id: "farcaster-social-velocity",
      name: "Farcaster Velocity & Organic Momentum",
      tagline: "Real-time cast velocity, bot spam filtering & organic social score",
      description:
        "🆕 Measures real-time Farcaster / Warpcast social momentum for tokens, memecoins, and AI agents on Base. Quantifies hourly cast velocity, author diversity ratio, engagement quality, and detects sybil astroturfing vs genuine viral attention. Returns a 0-100 momentum score and ORGANIC_VIRAL vs ASTROTURFED verdict. Pass query= (ticker, e.g. 'HIGHER' or token name).",
      price: "$0.03",
      icon: "🟣",
      category: "AI",
      params: [
        { name: "query", label: "Search query, token or agent ticker", placeholder: "HIGHER", required: true },
      ],
      handler: farcasterSocialVelocity,
    },
];
