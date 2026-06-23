# x402 Bazaar — Pay-per-call API marketplace with Base Builder Codes

A full, end-to-end demo of [**x402**](https://docs.cdp.coinbase.com/x402) on **Base mainnet** with
[**Builder Codes**](https://docs.cdp.coinbase.com/x402/core-concepts/builder-codes) — onchain
attribution of x402 payments via ERC-8021 Schema 2.

One Next.js app plays all three roles in the x402 flow:

| Role | Builder Code | Where |
|------|--------------|-------|
| **Seller** (resource server) | `a` (app) | `src/app/api/x402/[service]/route.ts` |
| **Buyer** (client) | `s` (service) | `src/app/api/buy/route.ts` |
| **Facilitator** (Coinbase CDP) | `w` = `cdp_facil` | settles + writes the calldata suffix |

## What it does

- **Marketplace** (`/`): several real x402-protected, pay-per-call endpoints. Click *Pay & call*,
  the buyer settles a USDC micro-payment on Base, you get the data + the settlement tx.
- **Attribution dashboard** (`/dashboard`): paste any Base settlement tx hash; we read its calldata
  and decode the `a` / `w` / `s` Builder Codes straight from chain (no DB, no trust).

## How Builder Codes are wired

**Seller** declares the app code per route:

```ts
import { BUILDER_CODE, declareBuilderCodeExtension } from "@x402/extensions/builder-code";

extensions: { [BUILDER_CODE]: declareBuilderCodeExtension(appBuilderCode) }
```

**Buyer** attaches the client code (and auto-echoes the seller's `a`):

```ts
import { BuilderCodeClientExtension } from "@x402/extensions/builder-code";

client.registerExtension(new BuilderCodeClientExtension(clientBuilderCode));
```

**Verification** reads it back from the chain:

```ts
import { parseBuilderCodeSuffixFromCalldata } from "@x402/extensions/builder-code";

const attribution = parseBuilderCodeSuffixFromCalldata(tx.input); // { a, w, s }
```

## Setup

1. **Install**
   ```bash
   npm install
   ```

2. **Get a Builder Code** at [dashboard.base.org](https://dashboard.base.org):
   register your app → verify your domain → **Settings → Builder Codes**.

3. **Configure** — copy `.env.example` to `.env.local` and fill in:
   - `APP_BUILDER_CODE` / `CLIENT_BUILDER_CODE` — your codes (`^[a-z0-9_]{1,32}$`)
   - `PAY_TO_ADDRESS` — wallet that receives USDC
   - `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` — from [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com) (needed for **mainnet** settlement)
   - `BUYER_PRIVATE_KEY` — a wallet with USDC + a little ETH on Base, used by the demo *Pay & call* button

4. **Run**
   ```bash
   npm run dev
   ```
   Open http://localhost:3000. The status bar shows whether the seller and buyer are fully wired.

> **Mainnet = real money.** Prices are tiny ($0.001–$0.002 USDC) but every *Pay & call* is a real
> onchain settlement. Keep the buyer wallet funded with only what you need.

## Verifying attribution

- In-app: every purchase shows its tx + decoded `a`/`w`/`s`, with links to BaseScan and the
  [Coinbase Builder Code checker](https://buildercode-checker.vercel.app/).
- In the Base dashboard: x402 traffic with your `a` code is attributed to your project (note: early
  user counts may be overstated since they reflect facilitator relayer addresses).

## Stack

Next.js 16 (App Router) · `@x402/next` · `@x402/fetch` · `@x402/evm` · `@x402/extensions` ·
`@coinbase/x402` (CDP facilitator) · viem · Tailwind CSS.

## Project layout

```
src/
  lib/
    config.ts        env + network constants
    services.ts      the marketplace catalog (+ handlers)
    x402-server.ts   seller: resource server + CDP facilitator
    x402-client.ts   buyer: signer + payment-enabled fetch
    store.ts         flat-file payment log
  app/
    api/x402/[service]/route.ts   seller endpoints (declares `a`)
    api/buy/route.ts              buyer (attaches `s`, settles)
    api/attribution/route.ts      decode `a/w/s` from calldata
    api/payments/route.ts         recent settlements
    api/status/route.ts           config status for the UI
    page.tsx                      marketplace
    dashboard/page.tsx            attribution dashboard
```
