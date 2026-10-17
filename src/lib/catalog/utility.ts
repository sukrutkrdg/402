/**
 * Utility, web extraction, lending, safe accounts, file storage, and compliance services
 */

import type { ServiceDef } from "./types";
import { morphoHealth, morphoLiquidations } from "../morpho";
import { stockCollateralRisk } from "../stock-collateral-risk";
import { metamorphoVault } from "../vault";
import { gasSponsor, paymasterAudit } from "../aa";
import { safeCheck } from "../safe";
import { x402MarketIntel } from "../x402-market-intel";
import { yieldScout } from "../yield-scout";
import { revokeBuilder } from "../revoke-builder";
import { safeApprove } from "../safe-approve";
import { urlExtract, urlToJson } from "../web-services";
import { webExtract, webSearch } from "../web-search";
import { exaContents, exaSearch } from "../exa";
import { sanctionsName } from "../sanctions-name";
import { fileConvert } from "../file-convert";
import { filePublish } from "../file-publish";
import { fileSlot, s3Config } from "../file-store";
import { hashUtil, ping, unitConvert } from "../compute-utils";
import { buyCredits } from "../credits";

export const UTILITY_SERVICES: ServiceDef[] = [
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
        { name: "market", label: "Morpho market id (optional)", placeholder: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836" },
      ],
      handler: morphoHealth,
      noFreeTier: true,
    },
  {
      id: "stock-collateral-risk",
      name: "Stock Loan Reopen Risk (Aave V4 + Morpho)",
      tagline: "Your tokenized-stock loan's health factor when the US market reopens",
      description:
        "Aave V4 and Morpho on Base lend USDC against tokenized stocks (AAPLc, NVDAc, TSLAc…), priced by a 24/5 oracle that freezes from Friday 20:00 to Sunday 20:00 ET while the tokens keep trading. This re-prices each collateral at the live Base DEX price: health factor now, projected at the reopen, the fall that liquidates, paused reserves and announced dividends. Pass wallet=. Not financial advice.",
      price: "$0.04",
      icon: "📉",
      category: "Lending",
      params: [{ name: "wallet", label: "Borrower wallet", placeholder: "0x… wallet", required: true }],
      handler: stockCollateralRisk,
    },
  {
      id: "morpho-vault",
      name: "Morpho Vault Risk",
      tagline: "Should you deposit into this MetaMorpho vault?",
      description:
        "🆕 A MetaMorpho vault spreads your deposit across Morpho Blue markets — your real risk is WHERE the curator put it and WHO can move it. Reads the vault's live allocation (concentration, per-market collateral + liquidation LTV), idle share, performance fee, timelock, and control (curator/owner/guardian, and whether one address holds both). Returns a diversified / concentrated / control_risk verdict: the read before parking funds in a yield vault. vault= required. Not financial advice.",
      price: "$0.05",
      icon: "🗄️",
      category: "Lending",
      params: [{ name: "vault", label: "MetaMorpho vault address", placeholder: "0x… vault", required: true }],
      handler: metamorphoVault,
      noFreeTier: true,
    },
  {
      id: "morpho-liquidatable",
      name: "Morpho Liquidation Feed",
      tagline: "Which Base Morpho positions are liquidatable right now?",
      description:
        "🆕 Built for liquidator / MEV searchers. Reconstructs the active borrower set on a Morpho Blue market from Borrow events, prices every position onchain in one multicall, and ranks them by liquidation health — flagging positions liquidatable NOW (health <= 1.0) and those one small move away, with the collateral price drop that tips each over. market= optional (defaults cbBTC/USDC), maxHealth= cutoff (default 1.1). Not financial advice.",
      price: "$0.06",
      icon: "⚔️",
      category: "Lending",
      params: [
        { name: "market", label: "Morpho market id (optional)", placeholder: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836" },
        { name: "maxHealth", label: "Health cutoff (optional)", placeholder: "1.1" },
      ],
      handler: morphoLiquidations,
      noFreeTier: true,
    },
  {
      id: "gas-payer",
      name: "Gas Sponsor Check",
      tagline: "Who pays this wallet's gas? Is it a sponsored smart account?",
      description:
        "🆕 A smart account's gas can be paid by a PAYMASTER instead of the account itself — invisible to every 'does this wallet spend ETH' heuristic. Reads a wallet's UserOperationEvents across BOTH EntryPoints (v0.6 + v0.7): is it a smart account, its op count and success rate, and WHO sponsors its gas (self vs which paymaster, per-sponsor share). A fully-sponsored account is typically app- or agent-operated. wallet= required, days= optional (default 30, max 90). Not financial advice.",
      price: "$0.05",
      icon: "⛽",
      category: "Accounts",
      params: [
        { name: "wallet", label: "Wallet address", placeholder: "0x... smart account / agent wallet", required: true },
        { name: "days", label: "Lookback days (optional)", placeholder: "30 (max 90)" },
      ],
      handler: gasSponsor,
      noFreeTier: true,
    },
  {
      id: "paymaster-check",
      name: "Paymaster Check",
      tagline: "Should you trust this Base gas paymaster?",
      description:
        "🆕 Given a paymaster address, audits whether it's a healthy, active gas sponsor. Reads its UserOperationEvents across both EntryPoints: sponsored op volume, distinct accounts served, success rate, total gas sponsored, and concentration (the share coming from its single busiest app). The read to run before integrating a paymaster (Coinbase / Pimlico / Alchemy / custom), or judging who funds a counterparty's gas. paymaster= required, days= optional (default 30, max 90). Not financial advice.",
      price: "$0.05",
      icon: "🛢️",
      category: "Accounts",
      params: [
        { name: "paymaster", label: "Paymaster address", placeholder: "0x... paymaster", required: true },
        { name: "days", label: "Lookback days (optional)", placeholder: "30 (max 90)" },
      ],
      handler: paymasterAudit,
      noFreeTier: true,
    },
  {
      id: "safe-check",
      name: "Safe Multisig Check",
      tagline: "Real M-of-N multisig, or a 1-of-1 that just looks like one?",
      description:
        // Kept under 500 characters on purpose: every endpoint whose description
        // crossed that mark has never settled through the CDP facilitator, and
        // shortening one is what flipped it from a rejected payment to a paid call.
        "🆕 Multisig / treasury intelligence. Given an address: is it a Gnosis Safe, its owners and M-of-N threshold, version, activity, and — critically — its enabled MODULES. A module can move the Safe's funds via execTransactionFromModule with no owner signatures, so each one is an address with unilateral control. Returns a multisig / single_signer / has_modules verdict: the counterparty check before you trust funds to a multisig. address= required. Not financial advice.",
      price: "$0.04",
      icon: "🔐",
      category: "Accounts",
      params: [{ name: "address", label: "Address to check", placeholder: "0x… Safe / treasury / counterparty", required: true }],
      handler: safeCheck,
      noFreeTier: true,
    },
  {
      id: "x402-market-intel",
      name: "x402 Market Intelligence",
      tagline: "What the Bazaar holds for a capability, and the real demand behind it",
      description:
        "Reads the CDP discovery index (the directory agents search) for a capability keyword and reports the competitive picture: how many indexed services match, distinct sellers, price range, networks, and the index's own 30-day demand metric — total calls and unique payers, real usage not a guess. For a builder choosing what to ship or an agent picking a provider. Pass payTo to scope to one seller. The index under-reports (partial), so counts are a floor. Not financial advice.",
      price: "$0.02",
      icon: "📈",
      category: "Utility",
      params: [
        { name: "query", label: "Capability / keyword", placeholder: "token safety", required: true },
        { name: "payTo", label: "Scope to one seller wallet (optional)", placeholder: "0x…" },
      ],
      handler: x402MarketIntel,
    },
  {
      id: "yield-scout",
      name: "Idle USDC Yield Scout",
      tagline: "Where should an agent's idle USDC sit on Base right now?",
      description:
        "Every pre-funded agent wallet carries idle USDC that earns nothing. This reads the live USDC supply rate across Base money markets (Aave v3, Moonwell) straight from each protocol — not a feed — and returns the best, with the annual yield on your balance so you can weigh moving against the gas. Rates are variable and change every block; a venue it could not read is excluded from 'best', never sent funds on an unconfirmed rate. Pass amount= for the yield projection. Not financial advice.",
      price: "$0.01",
      icon: "🌾",
      category: "Lending",
      params: [{ name: "amount", label: "Idle USDC balance (optional, for projection)", placeholder: "10000" }],
      handler: yieldScout,
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
      id: "safe-approve",
      name: "Safe Approve Builder",
      tagline: "Exact-amount approve calldata — never unlimited",
      description:
        "Unlimited allowances are the #1 drain vector, and agents reach for approve(max) on every swap. This builds ready-to-sign calldata for an approval of EXACTLY the amount you need (via the token's decimals) and refuses unlimited unless forced. Reads the live allowance and returns a revoke step first when one is already set (a non-zero→non-zero approve reverts on USDT-style tokens). Build-time prevention, not detection; we never hold keys. Not financial advice.",
      price: "$0.02",
      icon: "✅",
      category: "Utility",
      params: [
        { name: "token", label: "Token contract", placeholder: "0x… token", required: true },
        { name: "spender", label: "Spender (router/contract)", placeholder: "0x… spender", required: true },
        { name: "amount", label: "Exact amount to approve (or 'max')", placeholder: "100", required: true },
        { name: "owner", label: "Your wallet (optional, reads live allowance)", placeholder: "0x… wallet" },
        { name: "allowUnlimited", label: "Allow unlimited (1 = yes, not recommended)", placeholder: "" },
      ],
      handler: safeApprove,
    },
  {
      id: "url-extract",
      name: "URL to Text",
      tagline: "Any web page → clean, agent-ready text",
      description:
        "Pass a URL and get the page as clean text — furniture (nav, scripts, ads, footers) stripped, paragraphs preserved — plus its title, description and site name. The step every agent needs before it can reason about a page, and the one most agents can't do themselves: serverless runtimes and MCP clients have no browser and no HTML parser. Follows redirects safely, refuses non-text content, caps at 2 MB. Nothing crypto about it.",
      price: "$0.002",
      icon: "🌐",
      category: "Web",
      params: [
        { name: "url", label: "Page URL", placeholder: "https://example.com/article", required: true },
        { name: "maxChars", label: "Max characters (optional)", placeholder: "40000" },
      ],
      handler: urlExtract,
    },
  {
      id: "url-to-json",
      name: "URL to JSON",
      tagline: "Point at a page, name the fields, get JSON",
      description:
        "One call replaces two: fetches the page, strips it to readable text, then returns exactly the fields you asked for as schema-enforced JSON (fields=price,author,published — up to 10). Add list=true to pull EVERY repeated record on the page (listings, table rows, search results) as an array — that mode costs $0.06, since it needs a much larger output budget. Built for agents that need a fact off a page, not a pile of HTML — no browser, no parser, no scraping code.",
      // Priced per mode at challenge time (see the url-to-json branch in the x402
      // route): $0.01 for a normal extraction, $0.06 when list=true. This figure is
      // the default path — the one the catalog advertises and most callers hit.
      price: "$0.01",
      icon: "🧩",
      category: "Web",
      params: [
        { name: "url", label: "Page URL", placeholder: "https://example.com/product", required: true },
        { name: "fields", label: "Fields (comma-separated)", placeholder: "title, price, author, published", required: true },
        { name: "list", label: "Extract all records (true/false)", placeholder: "false" },
      ],
      handler: urlToJson,
      noFreeTier: true, // one LLM call per request — a free tier would be a real cost
    },
  {
      id: "web-search",
      name: "Web Search",
      tagline: "Ask the live web, get ranked sources plus a direct answer",
      description:
        "Search the live web from an agent that has no browser: pass query= and get back ranked results (title, URL, snippet, relevance score) plus a synthesized one-paragraph answer over them. maxResults=1..20 (default 5); includeAnswer=false to skip the summary and take sources only. The step before reasoning about anything that happened after the model's training cutoff — prices, releases, incidents, docs. Nothing crypto about it.",
      // Upstream is 1 credit per basic search at $0.008 pay-as-you-go (first 1,000
      // credits each month free), so $0.01 clears cost and sits on the market's
      // proven-demand median — the price both Tavily and the Exa resellers charge
      // for the same call.
      price: "$0.01",
      icon: "🔎",
      category: "Web",
      params: [
        { name: "query", label: "Search query", placeholder: "who won the 2026 Turkish Super Cup", required: true },
        { name: "maxResults", label: "Results (1-20)", placeholder: "5" },
        { name: "includeAnswer", label: "Include answer (true/false)", placeholder: "true" },
      ],
      handler: webSearch,
      noFreeTier: true, // every call spends an upstream credit — a free tier is a real cost
    },
  {
      id: "exa-search",
      name: "Exa Search",
      tagline: "Exa's neural web search, one call at a time",
      description:
        "Exa's neural web search, resold per call — no Exa account, no subscription, one USDC micro-payment. Pass query= and get ranked results: title, URL, publish date, author, relevance score. numResults=1..10 (default 5). type=auto|fast|instant. includeDomains= restricts the search. Add text=1 for matched highlights from each page (caps results at 5, priced $0.03; the 402 challenge quotes it). For agents that need what the web says today, not what a training cutoff remembers.",
      // $7/1k for up to 10 results is $0.007 a call, and $0.01 is what all four
      // Exa resellers in the index charge — including the one that beats Exa's own
      // $0.007 endpoint on volume. Matching the proven price, not undercutting it.
      price: "$0.01",
      icon: "🧠",
      category: "Web",
      params: [
        { name: "query", label: "Search query", placeholder: "best open-source vector databases 2026", required: true },
        { name: "numResults", label: "Results (1-10)", placeholder: "5" },
        { name: "type", label: "Search type (auto/fast/instant)", placeholder: "auto" },
        { name: "text", label: "Include page highlights (true/false)", placeholder: "false" },
        { name: "includeDomains", label: "Limit to domains (comma-separated)", placeholder: "arxiv.org, github.com" },
      ],
      handler: exaSearch,
      noFreeTier: true, // every call spends Exa credit, and a 200 without a challenge is invisible to discovery
    },
  {
      id: "exa-contents",
      name: "Exa Contents",
      tagline: "Read a page out of Exa's index, not off the open web",
      description:
        "Exa's own page index, read per call — no Exa account, no subscription. Pass urls= (one, or up to 5 comma-separated) and get each page as clean text with title, author and publish date. Answers from Exa's crawl rather than our fetcher, so it reads pages a plain server-side GET is blocked from. maxChars=500..40000 (default 8000). One URL is $0.002; a batch of 2-5 is $0.008, which the 402 challenge quotes. Pairs with exa-search: search, then read the winners.",
      // $1/1k per page: one page costs $0.001 and sells at the $0.002 the market
      // has proven. The batch tier is priced in effectivePriceFor, because the
      // cost is per page and the caller chooses how many.
      price: "$0.002",
      icon: "📄",
      category: "Web",
      params: [
        { name: "urls", label: "Page URLs (comma-separated, max 5)", placeholder: "https://github.com/qdrant/qdrant", required: true },
        { name: "maxChars", label: "Max characters per page", placeholder: "8000" },
      ],
      handler: exaContents,
      noFreeTier: true,
    },
  {
      id: "web-extract",
      name: "Batch Page Reader",
      tagline: "Up to 5 pages in one call — including the JavaScript ones",
      description:
        "Pass up to 5 URLs (comma-separated) and get each page back as clean text with its title. Renders pages that build their content in the browser, which a plain server-side fetch cannot read at all — so it covers the SPAs, dashboards and app pages that url-extract deliberately refuses. Returns partial success: pages that fail come back in a `failed` list with the reason, and a call where every URL fails is not charged. For a single static page, url-extract is cheaper.",
      // Upstream bills 1 credit ($0.008) per 5 successful URLs at basic depth, and
      // the handler caps the batch at 5 — so this price holds for every input.
      price: "$0.01",
      icon: "📚",
      category: "Web",
      params: [
        { name: "urls", label: "URLs (comma-separated, max 5)", placeholder: "https://a.com/post, https://b.com/docs", required: true },
      ],
      handler: webExtract,
      noFreeTier: true, // every call spends an upstream credit — a free tier is a real cost
    },
  {
      id: "sanctions-name",
      name: "OFAC Name Screening",
      tagline: "Screen a person or company against the OFAC SDN list",
      description:
        "Sanctions screening for NAMES, not wallets. Pass a person or company; get GO / HOLD / STOP against the official U.S. Treasury OFAC SDN export, including a.k.a. aliases. Conservative by design: only a full-name match is a hit. Screening aid, not a compliance determination.",
      price: "$0.05",
      icon: "⚖️",
      category: "Compliance",
      params: [
        { name: "name", label: "Person or company name", placeholder: "Acme Trading LLC", required: true },
      ],
      handler: sanctionsName,
      noFreeTier: true, // the OFAC export is a multi-megabyte fetch; free calls would carry real cost
    },
  {
      id: "file-convert",
      name: "Format Convert",
      tagline: "CSV in, JSON out — and back again",
      description:
        "Convert between the shapes data actually arrives in: CSV or TSV to JSON, JSON to CSV or TSV, CSV to a Markdown table, Markdown to HTML. Proper RFC 4180 parsing — quoted fields, embedded commas and newlines, doubled quotes — so a spreadsheet exported by a human does not silently come apart. Numbers and booleans get real types (turn it off with typed=false). No model call and no upstream: local parsing only.",
      price: "$0.005",
      icon: "🔀",
      category: "Files",
      params: [
        { name: "text", label: "Content to convert", placeholder: "name,qty\\nWidget,3", required: true },
        { name: "from", label: "Source format", placeholder: "csv | tsv | json | md", required: true },
        { name: "to", label: "Target format", placeholder: "json | csv | tsv | md | html", required: true },
        { name: "typed", label: "Type numbers/booleans (optional)", placeholder: "true (default) | false" },
      ],
      handler: fileConvert,
      // Pure CPU, no upstream: a free call costs us nothing but a millisecond, so
      // this one keeps the trial tier that gets agents in the door.
    },
  {
      id: "file-publish",
      name: "Publish Page",
      tagline: "Turn a report into a link a human can open",
      description:
        "Send Markdown (or HTML) and get back a URL that renders as a real page — headings, tables, code blocks, mobile-readable, no scripts and no external requests. The other half of an agent's output problem: file-slot is for bytes it will fetch back, this is for the report somebody has to read. Retention 1-30 days. Published on the storage origin, never on 402.com.tr.",
      price: "$0.01",
      icon: "📄",
      category: "Files",
      params: [
        { name: "text", label: "Markdown or HTML to publish", placeholder: "# Report\\n\\nFindings…", required: true },
        { name: "title", label: "Page title (optional)", placeholder: "Weekly report" },
        { name: "format", label: "md (default) or html", placeholder: "md" },
        { name: "ttlDays", label: "Retention in days (optional)", placeholder: "7 (1-30)" },
      ],
      handler: filePublish,
      noFreeTier: true,
      hidden: !s3Config(),
    },
  {
      id: "file-slot",
      name: "Agent File Slot",
      tagline: "Somewhere to put the file your agent just made",
      description:
        "Get a signed upload URL and a retrieval URL for one file, in one call. Your agent PUTs the bytes straight to storage — they never pass through this API, so there is no size ceiling imposed by a serverless runtime and no proxy in the middle. Declare bytes= and the size is signed into the URL. Up to 25 MB, retention 1-30 days, unguessable key. The step every agent hits the moment it produces a report, chart, CSV or build and has nowhere to put it.",
      price: "$0.005",
      icon: "📦",
      category: "Files",
      params: [
        { name: "bytes", label: "Exact file size in bytes", placeholder: "e.g. 20480", required: true },
        { name: "name", label: "File name (optional hint)", placeholder: "report.csv" },
        { name: "contentType", label: "Content type (optional)", placeholder: "text/csv" },
        { name: "ttlDays", label: "Retention in days (optional)", placeholder: "7 (1-30)" },
      ],
      handler: fileSlot,
      // No free tier: a free call here is free storage, and the response is a
      // credential rather than a report — there is nothing to preview.
      noFreeTier: true,
      // Listed only once a bucket is actually connected. Advertising a slot we
      // cannot issue would send an agent through the payment handshake to reach a
      // 503 — the same dead payment loop the five stuck endpoints were hidden for.
      hidden: !s3Config(),
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
    },
  {
      id: "hash",
      name: "Hash",
      tagline: "keccak256 / sha256 of text or hex — the most-bought x402 utility",
      description:
        "Compute keccak256 (the EVM/Solidity hash — event topics, function selectors, mapping keys) or sha256 of any input. Pass input=text for UTF-8, or 0x-hex to hash raw bytes; algo=keccak256 (default) or sha256. Returns the digest and, for keccak, the 4-byte function selector. Pure compute, no chain, sub-cent — the commodity hashing call the whole x402 ecosystem hammers, served at the floor. Not financial advice.",
      price: "$0.002",
      icon: "#️⃣",
      category: "Utility",
      params: [
        { name: "input", label: "Text or 0x-hex to hash", placeholder: "Transfer(address,address,uint256)", required: true },
        { name: "algo", label: "keccak256 (default) or sha256", placeholder: "keccak256" },
      ],
      handler: hashUtil,
    },
  {
      id: "unit-convert",
      name: "Unit Convert",
      tagline: "wei / gwei / ether — or any token decimals, both ways",
      description:
        "Convert an amount between wei, kwei, mwei, gwei, szabo, finney and ether — or between any token decimals (pass a number like 6 for USDC). Integer-exact, no precision loss. Pass amount, from, to. Pure compute, sub-cent — the unit-conversion commodity agents call constantly when building transactions. Not financial advice.",
      price: "$0.002",
      icon: "🔢",
      category: "Utility",
      params: [
        { name: "amount", label: "Amount", placeholder: "1.5", required: true },
        { name: "from", label: "From unit (or decimals number)", placeholder: "ether" },
        { name: "to", label: "To unit (or decimals number)", placeholder: "wei" },
      ],
      handler: unitConvert,
    },
  {
      id: "ping",
      name: "x402 Ping",
      tagline: "Always-returns health check — the cheapest end-to-end x402 test",
      description:
        "The cheapest possible end-to-end x402 purchase: always returns 200 with a timestamp (and echoes an optional message). Use it to verify your x402 client, the payment path and our settlement in one sub-cent call before wiring up a real endpoint — the pattern crawlers and monitors hit most across the network.",
      price: "$0.002",
      icon: "🏓",
      category: "Utility",
      params: [{ name: "echo", label: "Optional message to echo back", placeholder: "hello" }],
      handler: ping,
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
