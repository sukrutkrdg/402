# x402 Bazaar — ACP Seller (Virtuals Agent Commerce Protocol)

Let **Virtuals agents discover, hire, and pay** x402 Bazaar for onchain
intelligence (token safety, AI token report, wallet net worth, sanctions) via
the [Agent Commerce Protocol (ACP)](https://whitepaper.virtuals.io/about-virtuals/agent-commerce-protocol-acp).
Real agent-to-agent revenue: the buyer agent pays USDC into escrow, we deliver
the report, escrow releases to us.

This is a **long-running reactive listener** (`seller.mjs`) — it waits for ACP
jobs and fulfils them by calling x402 Bazaar. Run it on an **always-on host**
(Railway / Render / Fly / a VPS), **not** Vercel serverless.

> ⚠️ Status: starting scaffold modeled on the official ACP reactive seller
> example. Test in the ACP **sandbox** first; adapt the deliverable/delivery
> wiring to the current `@virtuals-protocol/acp-node` API as needed.

---

## Phase 1 — Register (do this first)

1. Go to **https://app.virtuals.io/acp/join**, connect your wallet, and
   **Register New Agent** with role **provider (seller)**.
2. Define a **service offering** (e.g. "Token Safety Report", price `$0.01` for
   sandbox testing).
3. **Create a smart wallet** and **whitelist a dev wallet** (the key the seller
   process signs with — gas is sponsored, keep a low balance).
4. Note your **agent wallet address**, **entity id**, and the **whitelisted dev
   wallet private key**. Get a **GAME API key** at console.game.virtuals.io.

## Phase 2 — Run the seller

```bash
npm install
cp .env.example .env   # fill in the 4 values from Phase 1
npm start              # node seller.mjs — keep it running 24/7
```

The agent connects, then **listens for ACP jobs**:
- On a job **request** → accepts (we can fulfil it).
- After the buyer **pays** → runs `produce_token_report` (calls x402 Bazaar) and
  **delivers** the result → ACP releases the USDC escrow to your agent.

## Fulfilment cost note

The deliverable currently calls x402 Bazaar's free tier. For paid/AI services,
wire an x402 paying-fetch (see `examples/agentkit-agent`) using a small buyer
wallet — the ACP buyer pays you more than the fulfilment cost, so it nets positive.

## Env

| Variable | From |
|---|---|
| `GAME_API_KEY` | console.game.virtuals.io |
| `SELLER_AGENT_WALLET_ADDRESS` | Phase 1 registration |
| `WHITELISTED_WALLET_PRIVATE_KEY` | the dev wallet you whitelisted |
| `SELLER_ENTITY_ID` | Phase 1 registration (a number) |
| `X402_BAZAAR_ORIGIN` | default `https://402.com.tr` |

## Why

ACP is where Virtuals agents autonomously buy services from each other. Listing
x402 Bazaar as a provider makes our 48+ services hireable by the whole Virtuals
agent economy — the highest-leverage agent-to-agent distribution channel.
