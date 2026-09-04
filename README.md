# x402 Bazaar — Pay-per-call API marketplace with Base Builder Codes

A **live pay-per-call API marketplace** on **Base mainnet** — [402.com.tr](https://402.com.tr).
142 public services as of 2026-09-04 ([live catalogue](https://402.com.tr/api/services)) — token safety,
the only B20 protection suite on Base incl. real-time seizure alerts and cover for all 13 of Coinbase's
tokenized equities, wallet intelligence, OFAC screening, AI-written reports — sold to AI agents and humans over
[**x402**](https://docs.cdp.coinbase.com/x402), settled in USDC via the Coinbase CDP facilitator,
with onchain attribution via [**Builder Codes**](https://docs.cdp.coinbase.com/x402/core-concepts/builder-codes)
(ERC-8021 Schema 2). Listed in the CDP x402 discovery index; consumable via MCP
([`x402-bazaar-mcp`](https://www.npmjs.com/package/x402-bazaar-mcp)), plain HTTP, or the Farcaster/Base App mini-app.

One Next.js app plays all three roles in the x402 flow:

| Role | Builder Code | Where |
|------|--------------|-------|
| **Seller** (resource server) | `a` (app) | `src/app/api/x402/[service]/route.ts` |
| **Buyer** (client) | `s` (service) | `src/app/api/buy/route.ts` |
| **Facilitator** (Coinbase CDP) | `w` = `cdp_facil` | settles + writes the calldata suffix |

## What it does

- **Marketplace** (`/`): every service is a real x402-protected, pay-per-call endpoint — pay from your own
  browser wallet (or the server buyer), a USDC micro-payment settles on Base, you get the data +
  the settlement tx. Safety responses include an auditable pre-spend `receipt` (GO/HOLD/STOP).
- **B20 protection suite**: 29 tools reading Base's native-token precompiles — freeze/seize risk,
  "when did it turn seizable", real-time PolicyUpdated alerts (CDP webhooks), launch radar.
- **Tokenized equities**: Coinbase's tokenized stocks are B20 Asset tokens, so the same reads cover
  them. `b20_safety` tells a real issuance apart from a token merely wearing an equity ticker, by
  checking who administers the transfer policy on chain — not by consulting a list of addresses.
  That recognises all 13 (AAPLc, AMZNc, COINc, CRCLc, GOOGLc, INTCc, METAc, MSFTc, MSTRc, NVDAc,
  SNDKc, SPCXc, TSLAc) with no per-token configuration, and a 14th the day it is issued. It also
  reports holder-eligibility gating and gated mint as the regulated shape they are, rather than
  scoring a compliant issuer as dangerous. What it does **not** claim is a corporate-action feed:
  across all thirteen the number of multiplier changes to date is zero, so there is nothing yet to
  serve — a watcher records the first one when it happens.
- **Protect wallet** (`/app?mode=wallet`): scan approvals, revoke the risky ones **gas-free**
  (sponsored via CDP Paymaster; one-signature Revoke All on smart wallets).
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
   - `BUYER_PRIVATE_KEY` — a wallet with USDC + a little ETH on Base, used by the server-side *Pay & call* button
   - `NEXT_PUBLIC_BASE_APP_ID` — your `base:app_id` (renders the Base App verification meta tag). **Not** the Builder Code — that's a separate short code under base.dev → Settings → Builder Code.
   - `ENABLE_BUYER` (`true`/`false`) and `BUY_ACCESS_TOKEN` — public-deploy safety (see below)

4. **Run**
   ```bash
   npm run dev
   ```
   Open http://localhost:3000. The status bar shows whether the seller and buyer are fully wired.

> **Mainnet = real money.** Prices are small ($0.002–$0.75 USDC per call) but every *Pay & call* is a real
> onchain settlement. Keep the buyer wallet funded with only what you need.

## Deploy to Vercel

The repo is Vercel-ready. Import `sukrutkrdg/402` in Vercel, add the env vars
above in **Project → Settings → Environment Variables**, and deploy.

**Before exposing it publicly, read this:**

- 🔑 **The buyer wallet spends real USDC.** `/api/buy` is the server-side spend endpoint.
  On a public URL, anyone could trigger payments. Protect it:
  - `ENABLE_BUYER=false` → fully view-only showcase (browse + on-chain dashboard, no spending), **or**
  - `BUY_ACCESS_TOKEN=<secret>` → callers must supply the token (UI field / `x-buy-token` header).
  - A per-IP rate limit (5/min) is always on as a backstop.
  - Keep only a small balance in the buyer wallet regardless.
- 💾 **Recent settlements are not durable on serverless.** The store keeps an
  in-memory cache + best-effort temp file; it won't persist across instances on
  Vercel. The dashboard's on-chain lookup is unaffected. For durable history,
  swap `src/lib/store.ts` for Vercel KV / Upstash (same function signatures).

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
