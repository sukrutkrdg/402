# Development notes

Pay-per-call API marketplace on Base (402.com.tr): services sold over x402 in USDC on Base,
settled by the Coinbase CDP facilitator, with Builder Code attribution. Next.js on Vercel, Upstash
Redis (KV) for counters, credits and state. See README.md for the architecture.

## Where things stand

`docs/near-plan.md` is the living plan and log for the NEAR work (section 9 lists what has been
done, section 8 what is next).

- NEAR discovery and buying credits with NEAR Intents are live (first NEAR sale 2026-09-26).
- Six NEAR-native services are live: `near-pre-trade-gate`, `near-token-safety`,
  `near-transfer-preflight`, `near-swap-quote`, `near-account`, `near-portfolio`.
- NEAR agent market (market.near.ai): the API list is in `docs/near-market/paths.txt`, the full
  OpenAPI spec in `docs/near-market/market.json`. A connector listing has been requested.

## Rules that keep the running system safe

- Never change the x402 challenge: `NETWORK` / `EXTRA_NETWORKS` in `src/lib/config.ts`,
  `src/lib/x402-server.ts`, or `accepts[]` on paid routes. (The Polygon note in config.ts explains
  why a second network hurt.)
- New features go in their own files behind an env flag, off by default.
- Credits are minted only through `mintCredits` (`src/lib/credits.ts`).
- KV: Upstash reports some failures as HTTP 200 with an `error` body — `src/lib/kv.ts` treats
  that as failure. Do not confirm a write by reading it back (replicas lag); use `kvSetChecked`.
  Commands are billed individually, so do not add KV commands to the per-request path casually.
- Service descriptions must stay under 499 bytes — past that the facilitator stops settling the
  service (`test/declaration-size.test.ts` guards it).
- Before creating an account, agent, listing or anything with side effects on an external
  service (market.near.ai, 1Click, …), agree it with the owner first.
- Before pushing: `npm run typecheck`, `npx vitest run`, `npm run build`. The live-network tests
  in `test/counterparty.test.ts` and `test/domain-check.test.ts` fail without internet.
