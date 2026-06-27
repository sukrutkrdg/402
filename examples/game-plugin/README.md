# x402 Bazaar plugin for Virtuals GAME

Give any [Virtuals **GAME**](https://docs.game.virtuals.io/) agent on Base
onchain intelligence — token risk, wallet net worth, OFAC sanctions, an AI token
verdict, and a market brief — each **paid per call in USDC over x402**, no API keys.

> Pattern: GAME decides + acts · **x402 Bazaar tells the agent what to act on**
> (risk, intelligence, AI verdicts) before it commits.

## Install

```bash
npm install @virtuals-protocol/game @x402/fetch @x402/evm @x402/extensions viem
```

## Use

`x402-bazaar-plugin.mjs` exports `x402BazaarWorker` (a GAME `GameWorker`). Add it
to your agent's workers:

```js
import { GameAgent } from "@virtuals-protocol/game";
import { x402BazaarWorker } from "./x402-bazaar-plugin.mjs";

const agent = new GameAgent(process.env.GAME_API_KEY, {
  name: "My Base agent",
  goal: "Trade safely on Base",
  description: "...",
  workers: [x402BazaarWorker],
});

await agent.init();
await agent.run(60);
```

The agent now has these functions (it picks them automatically):
- `x402_ai_token_report` — AI buy/avoid verdict for a token
- `x402_token_risk` — fast token safety scan
- `x402_wallet_networth` — wallet portfolio + USD
- `x402_sanctions` — OFAC screening
- `x402_market_brief` — AI Base market situational brief

## Env

| Variable | Purpose |
|---|---|
| `AGENT_PRIVATE_KEY` | Base wallet (holds USDC) used to pay x402 calls. Key stays local. |
| `X402_BAZAAR_ORIGIN` | optional — defaults to `https://402.com.tr` |

## Discover all services

48+ services, prices and schemas: <https://402.com.tr/.well-known/x402> ·
docs: <https://402.com.tr/agents> · MCP: `npx x402-bazaar-mcp`
