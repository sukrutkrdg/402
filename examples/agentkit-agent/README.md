# Build a Base AI agent with AgentKit + x402 Bazaar

A starter showing how to give a [Coinbase **AgentKit**](https://docs.cdp.coinbase.com/agentkit/docs/welcome)
agent on Base an **x402 Bazaar** action — so your agent can fetch onchain data &
AI reports (token risk, wallet net worth, OFAC sanctions, prices, AI verdicts)
and pay per call in USDC over x402, with **no API keys**.

> Pattern: **AgentKit acts** (wallet, swaps, transfers) · **x402 Bazaar tells it
> what to act on** (risk, intelligence, AI verdicts). Together = a safe, informed
> Base agent.

## Install

```bash
npm install @coinbase/agentkit @x402/fetch @x402/evm viem zod
```

## Use the action

`x402-bazaar-action.mjs` exports `x402BazaarAction`, a `customActionProvider`.
Register it with AgentKit alongside the built-in providers:

```js
import { AgentKit, walletActionProvider /* , cdpApiActionProvider, ... */ } from "@coinbase/agentkit";
import { x402BazaarAction } from "./x402-bazaar-action.mjs";

const agentKit = await AgentKit.from({
  // ...your wallet provider config...
  actionProviders: [
    walletActionProvider(),
    x402BazaarAction, // ← x402 Bazaar data + AI reports
  ],
});
// Pass agentKit's tools to your LLM framework (LangChain, Vercel AI SDK, etc.)
```

Now the agent can call, e.g.:
- `x402_bazaar { service: "ai-token-report", query: "address=0x…" }` → buy/avoid verdict
- `x402_bazaar { service: "wallet-networth", query: "address=0x…" }` → full portfolio + USD
- `x402_bazaar { service: "sanctions", query: "address=0x…" }` → OFAC screening

## Env

| Variable | Purpose |
|---|---|
| `AGENT_PRIVATE_KEY` | Base wallet (holds USDC) used to pay x402 calls. Key stays local. |
| `X402_BAZAAR_ORIGIN` | optional — defaults to `https://402.com.tr` |

## Discover services

All 43+ services, prices and schemas: <https://402.com.tr/.well-known/x402> ·
docs: <https://402.com.tr/agents>
