# @sukrutkrdg/plugin-x402-bazaar

**Check, then act** — an [x402 Bazaar](https://402.com.tr) plugin for [ElizaOS](https://github.com/elizaOS/eliza).

Your agent checks a token before it buys, then swaps at the best price — from its own wallet. Nothing is held by us.

| Action | What it does |
|---|---|
| `PRE_TRADE_CHECK` | GO / HOLD / STOP before buying a token on **Base** or **NEAR** |
| `SWAP_ON_BASE` | Best-price swap on Base (0x across Uniswap, Aerodrome, Balancer, Curve…), **executed** from the agent's wallet. Honeypots are refused |
| `CROSS_CHAIN_SWAP` | Swap across chains through NEAR Intents — NEAR, Base, Ethereum, Solana, Bitcoin… Paying from Base, the wallet sends the deposit itself |
| `CROSS_CHAIN_SWAP_STATUS` | Where a cross-chain swap is |
| `X402_BAZAAR_CALL` | Any of the 150+ services in the [catalog](https://402.com.tr/api/catalog) |

## Install

```bash
npm install @sukrutkrdg/plugin-x402-bazaar
```

```ts
import { x402BazaarPlugin } from "@sukrutkrdg/plugin-x402-bazaar";

export const character = {
  // …
  plugins: [x402BazaarPlugin],
  settings: {
    secrets: {
      X402_CREDIT_TOKEN: "ck_…", // pays calls; buy at https://402.com.tr/credits
      EVM_PRIVATE_KEY: "0x…",    // optional: signs swaps, pays per call without a token
    },
  },
};
```

| Setting | |
|---|---|
| `X402_CREDIT_TOKEN` | Prepaid credit token — one header per call, no signing |
| `EVM_PRIVATE_KEY` | Base wallet key — signs swaps and cross-chain deposits from Base; pays per call over x402 when there is no credit token |
| `X402_BAZAAR_EXECUTE` | `true` to let the agent send transactions (`SWAP_ON_BASE`, cross-chain deposits). Off by default: without it, swaps return instructions only |
| `X402_BAZAAR_RECIPIENTS` | Comma-separated addresses a cross-chain swap may deliver to when depositing automatically. A recipient outside the list gets instructions instead — parameters are read from chat, so keep this set |
| `X402_BAZAAR_URL` | Optional, defaults to `https://402.com.tr` |

Parameters are read from the conversation by the agent's model (or taken from the planner on runtimes that pass them). Calls cost $0.002–$0.10; failed calls are not charged. Swaps carry a small service fee inside the swap, shown in every quote.
