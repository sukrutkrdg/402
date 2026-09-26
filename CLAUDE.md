# x402 Bazaar — notes for Claude

Pay-per-call API marketplace on Base (402.com.tr): ~159 services sold over x402 in USDC on Base,
settled by the Coinbase CDP facilitator, with Builder Code attribution. Next.js on Vercel, Upstash
Redis (KV) for counters, credits and state. See README.md for the architecture.

The owner writes in Turkish; answer in Turkish.

## Where things stand

**Read `docs/near-plan.md` first** — it is the living plan and session log for the NEAR work
(section 9 lists everything done on 2026-09-26, section 8 says what is next).

- NEAR Phase 0 (discovery) and Phase 1 (buy credits with NEAR Intents) are **live**; the first
  NEAR sale settled on 2026-09-26.
- **Next:** Phase 2 — list x402 Bazaar as a seller on the new NEAR agent market
  (market.near.ai). Its API list is in `docs/near-market/paths.txt`; the full OpenAPI spec should
  be at `docs/near-market/openapi.json` (if it is missing, fetch
  `https://market.near.ai/openapi.json`). Do the "İlk oturumda yapılacaklar" list in Phase 2
  and get the owner's approval before writing code.

## Rules that keep the running system safe

- Never change the x402 challenge: `NETWORK` / `EXTRA_NETWORKS` in `src/lib/config.ts`,
  `src/lib/x402-server.ts`, or `accepts[]` on paid routes. (The Polygon note in config.ts explains
  why a second network hurt.)
- New features go in their own files behind an env flag, off by default.
- Credits are minted only through `mintCredits` (`src/lib/credits.ts`).
- KV: Upstash reports some failures as HTTP 200 with an `error` body — `src/lib/kv.ts` treats
  that as failure. Do not confirm a write by reading it back (replicas lag); use `kvSetChecked`.
  Commands are billed individually, so do not add KV commands to the per-request path casually.
- Before creating an account, agent, listing or anything with side effects on an external
  service (market.near.ai, 1Click, …), tell the owner exactly what the command will create.
- Before pushing: `npm run typecheck`, `npx vitest run`, `npm run build`. The live-network tests
  in `test/counterparty.test.ts` and `test/domain-check.test.ts` fail without internet.
