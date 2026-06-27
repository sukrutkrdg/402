# x402 Bazaar — onchain data & intelligence skill for Base agents

Give your assistant **48 pay-per-call APIs on Base** for token safety, wallet
intelligence, compliance, prices, NFTs, and AI-written reports. Every call is a
tiny **USDC micro-payment over x402** — no API keys, no subscriptions. Works
alongside **Base MCP / Base Account** (x402 is a first-class Base agent payment
rail).

- Live: https://402.com.tr
- Machine catalog: https://402.com.tr/.well-known/x402
- Agent docs: https://402.com.tr/agents

## When to use this skill

| The user / agent asks… | Use |
|---|---|
| "Is token X safe? Is it a rug / honeypot?" | `token-risk`, `rug-score`, `ai-token-report` |
| "Give me a verdict on token X" | `ai-token-report` (Claude-written) |
| "Screen address X for OFAC sanctions" | `sanctions`, `sanctions-batch`, `compliance-check` |
| "What's in wallet X? Net worth?" | `wallet-networth` |
| "How old / active is wallet X?" (sybil check) | `wallet-summary` |
| "Profile wallet X" | `ai-wallet-report` (Claude-written) |
| "What contracts can drain wallet X?" | `token-approvals` |
| "Recent activity / transfers of X" | `wallet-activity`, `token-transfers` |
| "Price / 24h momentum / pools of token X" | `token-price`, `token-momentum`, `token-pools` |
| "Price of token X on a past date" | `historical-price` |
| "Holder distribution of token X" | `holders` |
| "Is this contract verified? Its ABI?" | `contract-abi` |
| "Resolve jesse.base.eth / vitalik.eth" | `basename`, `ens-resolve` |
| "Gas / chain status" | `gas-oracle`, `chain-status` |
| "Alert me when token X crosses $Y" | `price-alert` (webhook) |
| "Summarize / extract / translate text" | `ai-summarize`, `ai-extract`, `ai-translate` |

Full, always-current list: fetch `https://402.com.tr/.well-known/x402`.

## How to call it

**Easiest — MCP server** (Claude Desktop, Cursor, any MCP client):

```json
{
  "mcpServers": {
    "x402-bazaar": {
      "command": "npx",
      "args": ["-y", "x402-bazaar-mcp"],
      "env": { "AGENT_PRIVATE_KEY": "0xYOUR_BASE_WALLET_KEY" }
    }
  }
}
```

**Or call directly over HTTP** — hit the endpoint, get `HTTP 402`, pay the USDC
micro-payment with an x402 client (e.g. `@x402/fetch`), retry:

```
GET https://402.com.tr/api/x402/<service>?<params>
```

## Payment

- **x402** protocol, **USDC on Base** (`eip155:8453`), gasless for the payer.
- The agent wallet only needs USDC; the key never leaves the caller's machine.
- The first few calls/day per IP are free (trial) for non-AI services.
- Every settlement is attributed onchain via **Builder Codes (ERC-8021)**.
