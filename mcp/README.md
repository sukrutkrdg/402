# x402-bazaar-mcp

An **MCP (Model Context Protocol) server** that exposes every paid API in the
[x402 Bazaar](https://402.com.tr) catalog as a callable tool for AI agents
(Claude Desktop, Cursor, custom agents, etc.).

Each tool call is backed by an **x402 micro-payment in USDC on Base** — no API
keys, no subscriptions, no sign-up.  The agent pays only for what it uses,
typically fractions of a cent per call.

---

## How it works

1. On startup the server fetches the live catalog from
   `https://402.com.tr/api/catalog` and auto-registers one MCP tool per
   service.
2. When an AI agent calls a tool the server builds the request URL, hits the
   endpoint, and transparently handles the x402 payment flow:
   `HTTP 402 → pay USDC on Base → retry → return response`.
3. The agent wallet only needs **USDC on Base**.  Gas is paid by the x402
   facilitator — it is **gasless for the payer**.

First few calls per day per service may be served on the **free tier** at no
cost; subsequent calls trigger micro-payments automatically.

---

## Requirements

- Node.js ≥ 20
- A Base wallet private key whose address holds USDC on Base mainnet

---

## Installation & running

```bash
# Install dependencies
npm install

# Run (set your private key in the environment)
AGENT_PRIVATE_KEY=0xYOUR_PRIVATE_KEY npx x402-bazaar-mcp
```

Or with `npm start` after cloning:

```bash
AGENT_PRIVATE_KEY=0xYOUR_PRIVATE_KEY npm start
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AGENT_PRIVATE_KEY` | **yes** | — | Hex private key for a Base wallet holding USDC. `0x` prefix is optional. |
| `X402_BAZAAR_CATALOG` | no | `https://402.com.tr/api/catalog` | Override the catalog URL (useful for local dev). |

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
        "AGENT_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY"
      }
    }
  }
}
```

After saving, restart Claude Desktop.  You should see the Bazaar tools appear
in the tool list (hammer icon).

---

## Cursor / other MCP clients

Any MCP-compatible client that supports stdio servers works the same way — just
point it at `npx x402-bazaar-mcp` with `AGENT_PRIVATE_KEY` in the environment.

---

## What your agent can do (tools)

Tools are loaded live from the catalog, so the list stays current. At the time of
writing it includes:

| Tool | Price | What it does |
|---|---|---|
| `token_risk` | $0.02 | Token safety score (honeypot, taxes, ownership, holders) for any Base token |
| `address_intel` | $0.01 | EOA/contract, ETH+USDC balance, activity for any address |
| `gas_oracle` | $0.005 | Live Base gas estimates (slow/normal/fast) |
| `token_price` | $0.01 | DEX price + liquidity for a Base token |
| `tx_decode` | $0.01 | Structural decode of a Base transaction |
| `wallet_tokens` | $0.01 | Portfolio of major Base tokens + USD value |
| `trending_tokens` | $0.005 | Currently boosted/trending Base tokens |
| `ai_summarize` / `ai_extract` / `ai_translate` | $0.02 | Claude-powered text utilities |

### Example

Once installed, just ask your agent naturally — it picks the right tool and pays per call:

> "Is `0x…` a safe token to buy on Base? Check the risk and current price."

The agent calls `token_risk` and `token_price`, each settling a tiny USDC payment
from your wallet, and answers with the on-chain data.

---

## Discovering available services

- Human-readable catalog & docs: <https://402.com.tr/agents>
- Machine-readable catalog (used by this server): <https://402.com.tr/api/catalog>
- x402 well-known: <https://402.com.tr/.well-known/x402>

---

## Security note

Your private key is only used locally inside this process to sign payment
authorizations.  It is **never** sent to the Bazaar server or any third party.
Use a dedicated spending wallet (not your main wallet) and keep only a small
USDC balance on it.

---

## License

MIT
