# Using x402 Bazaar from your agent

[x402 Bazaar](https://402.com.tr) is a pay-per-call API marketplace on Base. Your
agent pays a tiny USDC micro-payment per call over the **x402** protocol — no API
keys, no signup. Gas is paid by the facilitator (gasless for the payer).

Discover every service: <https://402.com.tr/api/catalog> · docs: <https://402.com.tr/agents>

There are three ways to integrate, easiest first.

---

## 1. MCP (Claude Desktop, Cursor, any MCP client) — recommended

Every Bazaar service appears as a tool automatically.

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

Package: [`x402-bazaar-mcp`](https://www.npmjs.com/package/x402-bazaar-mcp) ·
Registry: `io.github.sukrutkrdg/x402-bazaar-mcp`

---

## 2. Direct x402 call (any language/agent)

See [`call-x402-bazaar.mjs`](./call-x402-bazaar.mjs):

```bash
AGENT_PRIVATE_KEY=0x... node examples/call-x402-bazaar.mjs token-price \
  "address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
```

The `@x402/fetch` wrapper handles the `402 → pay USDC on Base → retry` handshake.

---

## 3. Base AgentKit custom action

Wrap a Bazaar call as an [AgentKit](https://docs.cdp.coinbase.com/agentkit/docs/welcome)
custom action so your AgentKit agent can call paid APIs. The payment itself uses
`@x402/fetch` with a dedicated spending wallet:

```ts
import { customActionProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const client = new x402Client();
client.register("eip155:8453", new ExactEvmScheme(account));
const payingFetch = wrapFetchWithPayment(fetch, client);

export const x402Bazaar = customActionProvider({
  name: "call_x402_bazaar",
  description:
    "Call a paid x402 Bazaar API on Base (token risk, prices, gas, wallet intel, " +
    "contract ABI, basename, AI utils). Pays a small USDC micro-payment per call.",
  schema: z.object({
    service: z.string().describe("Service id, e.g. token-risk, token-price, gas-oracle"),
    query: z.string().optional().describe("URL query string, e.g. address=0x..."),
  }),
  invoke: async (_walletProvider, { service, query }) => {
    const url = `https://402.com.tr/api/x402/${service}${query ? `?${query}` : ""}`;
    const res = await payingFetch(url);
    return await res.text();
  },
});
```

Give your agent a dedicated, low-balance Base wallet (USDC) for spending — the key
never leaves your process.

---

## Available services

Pulled live from the catalog (token-risk, address-intel, gas-oracle, token-price,
tx-decode, wallet-tokens, trending-tokens, price-alert, contract-abi, decode-selector,
basename, ai-summarize/extract/translate, and more). See
<https://402.com.tr/api/catalog>.
