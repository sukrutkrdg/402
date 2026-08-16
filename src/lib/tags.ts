/**
 * Discovery tags — the words an agent or a router actually searches for.
 *
 * Every listing used to carry the same three: the category, `x402`, `base`. So
 * all 60 Onchain services were `["onchain","x402","base"]`, and an agent (or a
 * routing oracle) looking for "honeypot", "rug check" or "sanctions" could not
 * reach any of them. Competitors in the same category tag
 * `security, token-safety, honeypot, rug-pull, rug-check, scam` — and the one
 * endpoint leading our category on distinct payers puts those exact words in
 * its listing.
 *
 * Tags are cheap and unbounded (unlike `description`, which the facilitator
 * refuses past ~500 code points), so the only cost of being specific is being
 * wrong. Rules, in order:
 *   1. an explicit per-service list, for the products we lead with;
 *   2. category keywords;
 *   3. words mined from the service id, which is already written for humans
 *      (`b20-freeze-check` → freeze, check).
 * Deduped, lowercase, capped so a listing stays readable.
 */

/** Words that carry no search intent on their own. */
const STOPWORDS = new Set(["ai", "api", "get", "the", "and", "a", "of", "v2", "x402", "base", "batch", "info", "check", "scan", "audit", "report"]);

const CATEGORY_TAGS: Record<string, string[]> = {
  Onchain: ["onchain", "base", "evm", "wallet-intel"],
  B20: ["b20", "base-token-standard", "freeze", "seize", "token-safety", "stablecoin", "compliance"],
  AI: ["ai", "llm", "analysis", "report"],
  Markets: ["market-data", "price", "liquidity", "dex"],
  Business: ["business", "verification", "due-diligence", "kyb"],
  Lending: ["lending", "defi", "morpho", "liquidation"],
  Accounts: ["account-abstraction", "smart-wallet", "paymaster", "erc4337"],
  Utility: ["utility", "agent-tooling"],
  Files: ["files", "storage", "documents", "agent-artifacts"],
  Web: ["web", "scraping", "extraction", "content"],
  Compliance: ["compliance", "sanctions", "ofac", "screening", "aml"],
};

/**
 * The listings worth naming precisely: our own category leaders, and anything
 * whose id does not say what a buyer would search for.
 */
const SERVICE_TAGS: Record<string, string[]> = {
  // Token safety — the category we compete in.
  "token-risk": ["security", "token-safety", "honeypot", "rug-pull", "rug-check", "scam", "contract-risk"],
  "rug-score": ["rug-pull", "rug-check", "token-safety", "scam", "risk-score"],
  sellability: ["honeypot", "can-i-sell", "sell-tax", "transfer-restriction", "token-safety", "exit"],
  "contract-danger": ["contract-risk", "token-safety", "mint", "pause", "blacklist", "upgradeable", "scam"],
  "pre-trade-gate": ["pre-trade", "token-safety", "honeypot", "rug-check", "trade-gate", "go-no-go"],
  "rug-monitor": ["rug-pull", "liquidity-drop", "monitor", "alert", "webhook", "token-safety"],
  "sign-guard": ["transaction-safety", "calldata", "approval", "sign", "wallet-security", "drainer"],
  "approval-advisor": ["approval", "allowance", "revoke", "wallet-security", "drain-risk"],
  "revoke-builder": ["revoke", "approval", "allowance", "wallet-security"],
  "deep-dd": ["due-diligence", "token-safety", "honeypot", "rug-check", "exit-liquidity", "research"],
  // Counterparty / address screening — the question with the most abandoned buyers.
  sanctions: ["sanctions", "ofac", "screening", "compliance", "aml", "counterparty"],
  "sanctions-batch": ["sanctions", "ofac", "screening", "compliance", "aml", "bulk"],
  "sanctions-name": ["sanctions", "ofac", "name-screening", "compliance", "aml"],
  "compliance-check": ["compliance", "sanctions", "counterparty", "screening", "send-safety"],
  "address-trust": ["counterparty", "address-reputation", "trust", "send-safety", "screening"],
  "address-intel": ["address-lookup", "counterparty", "wallet-intel", "eoa", "contract"],
  "first-funder": ["provenance", "funding-source", "sybil", "counterparty", "wallet-age"],
  "counterparty-check": ["counterparty", "supplier", "due-diligence", "kyb", "business-verification"],
  // Wallet exposure.
  "agent-wallet-audit": ["wallet-security", "approval", "spend-permission", "delegation", "drain-risk"],
  "wallet-delegation": ["eip-7702", "delegation", "smart-wallet", "wallet-security"],
  "portfolio-scan": ["portfolio", "holdings", "token-safety", "wallet-intel"],
  "spend-audit": ["spend-permission", "base-account", "wallet-security", "allowance"],
  // Raw reads — the shape with the widest reach on the network.
  "base-block": ["json-rpc", "block", "chain-read", "primitive"],
  "base-tx": ["json-rpc", "transaction", "chain-read", "primitive"],
  "base-receipt": ["json-rpc", "receipt", "chain-read", "primitive"],
  "base-nonce": ["json-rpc", "nonce", "chain-read", "primitive"],
  "token-balance": ["json-rpc", "erc20", "balance", "chain-read", "primitive"],
  "token-supply": ["json-rpc", "erc20", "supply", "chain-read", "primitive"],
  "contract-info": ["json-rpc", "contract", "bytecode", "chain-read", "primitive"],
  "ens-resolve": ["ens", "name-resolution", "chain-read", "primitive"],
  basename: ["basename", "name-resolution", "base", "primitive"],
  "basename-profile": ["basename", "profile", "name-resolution", "identity"],
};

const MAX_TAGS = 12;

/** Search tags for a listing. Always includes `x402` and `base` last. */
export function tagsFor(service: { id: string; category?: string }): string[] {
  const out = new Set<string>();
  for (const t of SERVICE_TAGS[service.id] ?? []) out.add(t);
  for (const t of CATEGORY_TAGS[service.category ?? ""] ?? [String(service.category ?? "").toLowerCase()]) {
    if (t) out.add(t);
  }
  // The id is already written for a human to read; mine it for anything the
  // lists above missed, so a service added later is never left with three
  // generic words.
  for (const word of service.id.split("-")) {
    if (out.size >= MAX_TAGS) break;
    if (word.length > 2 && !STOPWORDS.has(word)) out.add(word);
  }
  const tags = [...out].slice(0, MAX_TAGS);
  return [...tags.filter((t) => t !== "x402" && t !== "base"), "base", "x402"];
}
