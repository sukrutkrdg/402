# Decision receipt

Every **paid** call on x402 Bazaar returns a `receipt` — a machine-verifiable
record of *what was evaluated, under which logic, and how sure the answer is*.
Payment success is the trivial receipt; this is the one an agent needs to route
work to a check **by default**.

The receipt is additive: it sits alongside a service's normal response fields.
It is present on paid responses (x402 settlement **or** a prepaid `x-credit-token`
call). Free-tier preview responses omit it.

## Fields

| Field | Type | Meaning |
|---|---|---|
| `endpoint` | string | The check that produced this verdict, e.g. `token-risk`. |
| `inputHash` | string | `sha256:` + 32 hex — a canonical hash of the exact inputs (`{endpoint + params}`). Addresses are lowercased and keys sorted, so the **same logical input always hashes identically**. Use it to dedupe, cache, and prove which input a verdict ran on. |
| `policyVersion` | string | `endpoint@semver` of the decision logic. Bumped when a check's scoring/rules change, so you can detect that the policy behind a verdict moved between calls. |
| `decision` | string | `GO` \| `HOLD` \| `STOP` \| `REFUSE` (verdict checks only). `REFUSE` = a non-decision (see confidence/refusal). |
| `confidence` | `{ band, basis }` | `band` is `high` \| `medium` \| `low`. `low` when our core data feed was unavailable; `medium` when some secondary signals were missing; `high` when every declared input was consulted. `basis` is a human-readable rationale. *(verdict checks)* |
| `refusal` | `{ reason, missing } \| null` | Structured non-decision. `null` on a real verdict; populated when the check could not decide (`reason`, plus the `missing` inputs). Lets you distinguish "clean" from "couldn't determine". *(verdict checks)* |
| `refundable` | boolean | Whether **this** call qualifies for a refund (a refusal is never billed on the credit path). *(verdict checks)* |
| `refundRule` | string | The stated, enforced rule you can rely on (see below). *(verdict checks)* |

### Two tiers

- **Verdict / risk checks** carry the full receipt (all fields above): `token-risk`,
  `rug-score`, `sellability`, `pre-trade-gate`, `b20-safety`, `sanctions`,
  `address-trust`.
- **Every other paid service** carries a **baseline** receipt — `endpoint`,
  `inputHash`, `policyVersion` — so any call is verifiable and dedupable even when
  a confidence/decision would not be meaningful (e.g. data lookups, AI reports).

## Refund rule

A **refusal** — a `confidence: low` non-decision because our core data feed was
unavailable this call — is **delivered but not billed on the credit path**. The
gateway auto-refunds the debit and returns `x-refunded: true`, with
`paidVia: "credits-refunded"` and `refunded: true` in the body. Full-confidence
verdicts are final.

> Direct x402 settlements are on-chain and cannot be reversed, so the refund rule
> is scoped to the credit path (`x-credit-token`). Refusals are rare by design —
> they fire only when *our own* core feed is down, not on any normal verdict.

## Policy versions

| endpoint | policyVersion |
|---|---|
| token-risk | `token-risk@1.2.0` |
| rug-score | `rug-score@1.1.0` |
| sellability | `sellability@1.0.0` |
| pre-trade-gate | `pre-trade-gate@1.0.0` |
| b20-safety | `b20-safety@1.0.0` |
| sanctions | `sanctions@1.0.0` |
| address-trust | `address-trust@1.0.0` |
| deep-dd | `deep-dd@1.0.0` |
| *(all other paid services)* | `<endpoint>@1.0.0` |

## Examples

Full-confidence verdict (`token-risk` on USDC):

```json
"receipt": {
  "checked": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "endpoint": "token-risk",
  "decision": "GO",
  "inputHash": "sha256:0eb251f4770a1d8502adc2ead1fbc3b1",
  "policyVersion": "token-risk@1.2.0",
  "confidence": { "band": "high", "basis": "all declared inputs were consulted" },
  "refusal": null,
  "refundable": false,
  "refundRule": "A refusal (confidence=low: our core data feed was unavailable) is not billed on the credit path — the debit is auto-refunded and x-refunded:true is returned. Full-confidence verdicts are final."
}
```

Refusal (core feed unavailable) — delivered, **not billed**:

```json
"receipt": {
  "endpoint": "rug-score",
  "decision": "REFUSE",
  "inputHash": "sha256:53c90e77aa4b414322aa5bef94a973c9",
  "policyVersion": "rug-score@1.1.0",
  "confidence": { "band": "low", "basis": "core data feed unavailable this call — verdict is a partial read" },
  "refusal": { "reason": "upstream_data_unavailable", "missing": ["goplus-security-feed (honeypot/taxes)"] },
  "refundable": true,
  "refundRule": "..."
}
```

Baseline receipt on a data service (`token-price`):

```json
"receipt": {
  "endpoint": "token-price",
  "inputHash": "sha256:bd02258cb9c8cd5fb43534c0b915bfd3",
  "policyVersion": "token-price@1.0.0"
}
```
