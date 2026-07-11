# x402-bazaar-mcp

An **MCP (Model Context Protocol) server** that exposes every paid API in the
[x402 Bazaar](https://402.com.tr) catalog as a callable tool for AI agents
(Claude Desktop, Cursor, custom agents, etc.).

Each tool call is backed by an **x402 micro-payment in USDC on Base** — no API
keys, no subscriptions, no sign-up.  The agent pays only for what it uses,
typically fractions of a cent per call.

**Works with zero config.** Run it with no wallet and no token and it uses the
**free tier** (one free call/day per service, then a preview) — so an agent can
try every tool instantly. Unlock unlimited paid calls with either a **prepaid
credit token** (buy once, no wallet, no signing) or a **wallet key**.

---

## How it works

1. On startup the server fetches the live catalog from
   `https://402.com.tr/api/catalog` and auto-registers one MCP tool per
   service.
2. When an AI agent calls a tool the server picks a payment mode (below), hits
   the endpoint, and returns the response.
3. In wallet mode the x402 flow is transparent:
   `HTTP 402 → pay USDC on Base → retry → return response`, gasless for the payer
   (the facilitator pays gas).

### Three payment modes (precedence order)

| Mode | Set | What happens | Wallet? Signing? |
|---|---|---|---|
| **Credits** ⭐ | `X402_CREDIT_TOKEN` | Sent as `x-credit-token`; each call debits your prepaid balance | No / No |
| **Wallet** | `AGENT_PRIVATE_KEY` | Signs an x402 USDC payment locally per call | Yes / Yes |
| **Free** | *(nothing)* | Free tier: 1 full call/day/service, then a preview | No / No |

Credits are the easiest paid mode: call the `buy_credits` tool once (or buy at
[402.com.tr](https://402.com.tr)) to get a `ck_…` token, set it as
`X402_CREDIT_TOKEN`, and every call just draws down the balance — no private key
ever touches the config.

---

## Requirements

- Node.js ≥ 20
- *(optional, for paid calls)* a prepaid credit token **or** a Base wallet
  private key whose address holds USDC on Base mainnet

---

## Installation & running

```bash
npm install

# Zero-config — free tier, try every tool instantly:
npx x402-bazaar-mcp

# Paid via prepaid credits (recommended — no wallet, no signing):
X402_CREDIT_TOKEN=ck_your_token npx x402-bazaar-mcp

# Paid via wallet:
AGENT_PRIVATE_KEY=0xYOUR_PRIVATE_KEY npx x402-bazaar-mcp
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `X402_CREDIT_TOKEN` | no | — | Prepaid credit token (`ck_…`) from `buy-credits`. Sent as `x-credit-token`; debits your balance per call. No wallet needed. **Recommended paid mode.** |
| `AGENT_PRIVATE_KEY` | no | — | Hex private key for a Base wallet holding USDC. `0x` prefix optional. Used only if no credit token is set. |
| `X402_BAZAAR_CATALOG` | no | `https://402.com.tr/api/catalog` | Override the catalog URL (useful for local dev). |

With none of the above set, the server runs on the **free tier**.

---

## Claude Desktop configuration

Add the following to your `claude_desktop_config.json`
(usually `~/Library/Application Support/Claude/claude_desktop_config.json` on
macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "x402-bazaar": {
      "command": "npx",
      "args": ["-y", "x402-bazaar-mcp"],
      "env": {
        "X402_CREDIT_TOKEN": "ck_your_token"
      }
    }
  }
}
```

Omit the `env` block entirely to run on the **free tier** (great for a first
try), or use `"AGENT_PRIVATE_KEY": "0x…"` instead of the credit token to pay
from a wallet.

After saving, restart Claude Desktop.  You should see the Bazaar tools appear
in the tool list (hammer icon).

---

## Cursor / other MCP clients

Any MCP-compatible client that supports stdio servers works the same way — just
point it at `npx x402-bazaar-mcp` with `AGENT_PRIVATE_KEY` in the environment.

---

## Use with Coinbase AgentKit, Agentic Wallet & Claude Code

Because this is a standard MCP stdio server, any MCP-capable agent runtime can
load and pay for the Bazaar's tools — including Coinbase's own agent stack, with
no bespoke integration:

### Coinbase Agentic Wallet (`npx awal`)

Coinbase [Agentic Wallets](https://www.coinbase.com/developer-platform) ship
native x402 support and an MCP interface. Point the wallet's MCP config at
`npx x402-bazaar-mcp`, and the agent can call — and pay for — any Bazaar service
straight from its MPC-secured wallet, gasless on Base. The x402 payment handshake
is handled for you: `HTTP 402 → pay USDC on Base → retry → response`.

### Coinbase AgentKit

AgentKit agents that support MCP servers load the Bazaar tools the same way
(`command: npx`, `args: ["-y", "x402-bazaar-mcp"]`, `AGENT_PRIVATE_KEY` in env).
The agent gains on-chain safety/intel + AI tools as pay-per-call actions — token
risk, honeypot/sellability checks, deployer reputation, exit liquidity, live DEX
prices, gas, tx decode, and Claude-powered reports — without writing an action
provider for each.

### Claude Code

Add it as an MCP server in one command:

```bash
# Free tier (zero config):
claude mcp add x402-bazaar -- npx -y x402-bazaar-mcp

# Or paid via prepaid credits:
claude mcp add x402-bazaar -e X402_CREDIT_TOKEN=ck_your_token -- npx -y x402-bazaar-mcp
```

Then ask Claude Code to check a token, price a portfolio, or screen an address —
it calls the right Bazaar tool and settles the micro-payment automatically.

---

## Why agents use this

Agents need fresh on-chain data and AI utilities but don't want to manage RPC endpoints, scrapers, security heuristics, or per-provider API keys. One MCP server plus a funded wallet gives them everything — contract safety checks, live DEX prices, gas estimates, transaction decoding, and Claude-powered text utilities — all pay-per-use, with no subscriptions or sign-up required.

---

## What your agent can do (tools)

Tools are loaded live from the catalog, so the list stays current. At the time of
writing it includes:

| Tool | Price | What it does |
|---|---|---|
| `token_risk` | $0.02 | Token safety score (honeypot, taxes, ownership, holders) for any Base token |
| `sanctions` | $0.01 | Screen an address against the OFAC sanctions list |
| `holders` | $0.01 | Top holders, concentration (whale risk) & LP lock for a token |
| `token_price` | $0.01 | DEX price + liquidity for a Base token |
| `multi_price` | $0.01 | Prices for up to 10 Base tokens in one call |
| `address_intel` | $0.01 | EOA/contract, ETH+USDC balance, activity for any address |
| `wallet_tokens` | $0.01 | Portfolio of major Base tokens + USD value |
| `gas_oracle` | $0.005 | Live Base gas estimates (slow/normal/fast) |
| `tx_decode` | $0.01 | Structural decode of a Base transaction |
| `contract_abi` | $0.01 | Is a contract verified? Get its ABI (Sourcify) |
| `decode_selector` | $0.005 | Resolve a 4-byte selector to function signatures |
| `basename` | $0.005 | Resolve Basenames ↔ addresses on Base |
| `trending_tokens` / `new_tokens` | $0.005 | Trending & freshly listed Base tokens |
| `price_alert` | $0.05 | Register a webhook alert when a token crosses a price |
| `ai_summarize` / `ai_extract` / `ai_translate` | $0.02 | Claude-powered text utilities |

…plus more — the tool list is loaded **live from the catalog**, so it always reflects the current marketplace (70+ services, including `pre_trade_gate`, `whale_flow`, `watchlist_diff`, the B20 safety suite, and `buy_credits`).

### Example

Once installed, just ask your agent naturally — it picks the right tool and pays per call:

> "Is `0x…` a safe token to buy on Base? Check the risk and current price."

The agent calls `token_risk` and `token_price`, each settling a tiny USDC payment
from your wallet, and answers with the on-chain data.

---

## Sample outputs

### `token_risk` — low-risk token

```json
{
  "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "isContract": true,
  "token": {
    "name": "USD Coin",
    "symbol": "USDC",
    "decimals": 6,
    "totalSupply": "4800000000000000"
  },
  "ownership": {
    "owner": "0x0000000000000000000000000000000000000000",
    "renounced": true
  },
  "upgradeableProxy": false,
  "security": {
    "isHoneypot": false,
    "buyTaxPct": 0,
    "sellTaxPct": 0,
    "isOpenSource": true,
    "isMintable": false,
    "transferPausable": false,
    "canTakeBackOwnership": false,
    "hiddenOwner": false,
    "holderCount": 182430,
    "topHolderPct": 12.47,
    "top10HolderPct": 41.22,
    "lockedLpPct": 100,
    "creatorPct": 0,
    "isInDex": true,
    "isAntiWhale": false,
    "antiWhaleModifiable": false,
    "tradingCooldown": false,
    "slippageModifiable": false,
    "isTrueToken": true,
    "isAirdropScam": false,
    "creatorAddress": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    "creatorBalance": "0"
  },
  "riskScore": 0,
  "riskLevel": "low",
  "flags": [],
  "sources": ["base-rpc", "goplus"],
  "coverage": "RPC base + GoPlus security (honeypot, taxes, holders, holder concentration, LP lock, creator holdings, source, ownership controls).",
  "checkedAt": "2026-06-23T09:14:02.381Z"
}
```

### `token_price` — DEX price and liquidity

```json
{
  "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "priceUsd": "0.9998",
  "priceChange24h": -0.03,
  "liquidityUsd": 4721850.44,
  "volume24h": 18340210.77,
  "dexId": "uniswap",
  "pairAddress": "0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C",
  "baseToken": {
    "name": "USD Coin",
    "symbol": "USDC"
  },
  "checkedAt": "2026-06-23T09:14:03.105Z"
}
```

---

## Discovering available services

- Human-readable catalog & docs: <https://402.com.tr/agents>
- Machine-readable catalog (used by this server): <https://402.com.tr/api/catalog>
- x402 well-known: <https://402.com.tr/.well-known/x402>

---

## Security note

**Prepaid credits (recommended) need no wallet at all** — the `ck_…` token is a
bearer capability worth only its remaining balance, so a leaked token can lose at
most what's left on it, never a wallet. Buy a small pack and rotate it if needed.

If you use **wallet mode** instead, your private key is only used locally inside
this process to sign payment authorizations. It is **never** sent to the Bazaar
server or any third party. Use a dedicated spending wallet (not your main wallet)
and keep only a small USDC balance on it.

---

## License

MIT
