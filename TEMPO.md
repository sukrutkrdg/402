# Tempo — expansion plan & decision

**Status: groundwork laid, enablement blocked on a facilitator decision.**

## Why Tempo
Tempo is Stripe + Paradigm's EVM-compatible payments L1 (chain **4217**, mainnet
live 2026-03-18, RPC `https://rpc.tempo.xyz`, USDC `0x20c0…8b50`). It is a real,
active x402 venue: on Agent Charts, **aisa.one earns ~$2,084/mo entirely on Tempo**
and **stableenrich.dev** added Tempo to its data-feed stack. It's an emerging chain
with far less competition than Base — the same early-mover opening we took on
Robinhood Chain. The prize is **being payable on Tempo** so Tempo-native agents can
buy our existing services (not adding Tempo-specific read endpoints, for which there
is no observed demand — see the monetization note).

## Why it isn't flipped on yet (two real blockers)
1. **Settlement.** Our stack settles via the **CDP facilitator**, which supports
   Base + Solana, **not Tempo**. Tempo's x402 runs on **Stripe's Machine Payments
   Protocol (MPP)** facilitator. We cannot settle a Tempo payment through CDP today.
2. **EVM `accepts[]` ambiguity.** Tempo and Base are both `eip155`. Advertising both
   in one 402 challenge's `accepts[]` hands an EVM payer two options to resolve —
   the exact reason `EXTRA_NETWORKS` is empty and Solana (a different VM) was the
   only multi-chain acceptance we added. Enabling Tempo means *handling* that
   ambiguity (e.g. per-route network binding), not just appending a network.

## Groundwork already in place
- `src/lib/config.ts`: `TEMPO_NETWORK` (`eip155:4217`), `TEMPO_CHAIN_ID`,
  `TEMPO_RPC_URL`, `TEMPO_USDC` — dormant constants, **not wired into the live
  `accepts[]`**, so Base is untouched. Enabling becomes a config change, not a hunt.

## The two paths to unblock (decision needed)
| Path | What it takes | When it's right |
|------|---------------|-----------------|
| **A — Wait for CDP** | Flip a gated `facilitatorSupportsTempo()` check (mirrors `facilitatorSupportsSolana()`) + handle the EVM-ambiguity binding. Low effort, zero new trust. | If CDP adds `eip155:4217` to its supported map. Poll `getSupportedKind(2,"eip155:4217","exact")`. |
| **B — Integrate Stripe MPP** | Register Stripe's x402 facilitator/scheme for Tempo alongside CDP; new payTo on Tempo (the EVM payTo address works on Tempo). Bigger lift, a second facilitator in the path. | If Tempo demand justifies it before CDP moves. See `docs.stripe.com/payments/machine/x402`. |

**Recommendation:** Path A. The Base rail must stay un-breakable; adding a second
facilitator (Path B) touches the sacred settlement path for a market still in the
low thousands/mo. Keep the groundwork warm, poll CDP's supported map, and flip the
moment `eip155:4217` appears — exactly how Solana went live.

## When enabling (checklist)
1. Confirm CDP (or Stripe MPP) settles `eip155:4217`.
2. Add a `facilitatorSupportsTempo()` gate (copy the Solana pattern in
   `x402-server.ts`) — advertise the Tempo `accepts[]` entry ONLY when the live
   supported-map confirms, so a misconfig can never break Base's 402.
3. Resolve EVM-ambiguity: bind Tempo as a distinct, opt-in accept (not a silent
   second eip155 option in every challenge).
4. Set `ENABLE_TEMPO_PAYMENTS` env flag for instant kill without a deploy.
5. Verify end-to-end with a real paid call before announcing.
