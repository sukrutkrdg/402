# x402-bazaar-agentkit

**Check, then act** — [x402 Bazaar](https://402.com.tr) actions for [Coinbase AgentKit](https://github.com/coinbase/agentkit).

Your agent checks a token before it buys, then swaps at the best price — from its own wallet. Nothing is held by us.

| Action | What it does |
|---|---|
| `pre_trade_check` | GO / HOLD / STOP before buying a token on **Base** (honeypot and sell-tax simulation, owner powers, liquidity, deployer) or **NEAR** (keys, owner, pause, exit tested through NEAR Intents) |
| `swap_on_base` | Best-price swap on Base, routed by 0x across Uniswap, Aerodrome, Balancer, Curve and more — **executed** from the AgentKit wallet (approves exactly the amount sold). Unknown tokens get a sellability check; honeypots are refused |
| `cross_chain_swap` | Swap across chains through NEAR Intents — NEAR, Base, Ethereum, Solana, Bitcoin… Paying from Base, the wallet sends the deposit itself |
| `cross_chain_swap_status` | Pending, processing, SUCCESS, REFUNDED or FAILED |
| `x402_bazaar_call` | Any of the 150+ services in the [catalog](https://402.com.tr/api/catalog): wallet and approval audits, NEAR portfolio / staking yields / lending health, web search, page-to-JSON, OFAC screening… |

## Install

```bash
npm install x402-bazaar-agentkit @coinbase/agentkit
```

```ts
import { AgentKit } from "@coinbase/agentkit";
import { x402BazaarActionProvider } from "x402-bazaar-agentkit";

const agentkit = await AgentKit.from({
  walletProvider, // any EvmWalletProvider on Base mainnet
  actionProviders: [
    x402BazaarActionProvider({ creditToken: process.env.X402_CREDIT_TOKEN }),
  ],
});
```

## Paying

- **Credit token** (recommended): buy once at [402.com.tr/credits](https://402.com.tr/credits) — with USDC on Base, a card, or from NEAR — and pass it as `creditToken`. Each call debits its price; no signing per call.
- **No token**: each call is paid over [x402](https://x402.org) in USDC on Base, signed by the AgentKit wallet.

Calls cost $0.002–$0.10. Swaps carry a small service fee inside the swap itself, shown in every quote. If a call fails, it is not charged.
