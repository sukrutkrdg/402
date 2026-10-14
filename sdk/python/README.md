# bazaar402

Python client for [x402 Bazaar](https://402.com.tr): pay-per-call APIs for AI
agents (token safety checks, wallet audits, swaps, web search, page-to-JSON, AI
reports, ...). Each call is paid with an [x402](https://x402.org) USDC payment on
Base, or drawn from a prepaid credit token. Some services also have a free daily
call.

> Note: the PyPI package named `x402-bazaar` is a different, unrelated project.
> It is not published or maintained by 402.com.tr. This package is `bazaar402`.

## Install

```bash
pip install bazaar402            # free tier + prepaid credit token (only needs requests)
pip install "bazaar402[wallet]"  # + pay per call from your own wallet (x402 / USDC on Base)
pip install "bazaar402[langchain]"  # + LangChain tool helper
```

Python 3.10+.

## Three ways to pay

| Mode | What you need | How it works |
| --- | --- | --- |
| Free tier | nothing | `call_free()` adds `?free=1`. One full call per service per day per IP, then a preview (`"preview": true`). AI/metered services have no free tier. |
| Credit token | a `ck_...` token | Sent as the `x-credit-token` header; each call's price is debited from the balance. No wallet or signature per call. Buy one at https://402.com.tr/credits or via the `buy-credits` service. |
| Wallet (x402) | private key of a wallet with USDC on Base | The client reads the 402 challenge, signs an EIP-3009 USDC authorization locally, and retries with the `PAYMENT-SIGNATURE` header. The server only settles if the service answered successfully. |

## Usage

```python
from bazaar402 import BazaarClient

client = BazaarClient()  # no payment configured

# What's on offer (free)
services = client.catalog()["services"]

# Price of a call, read from the 402 challenge. Nothing is paid.
q = client.quote("token-risk", address="0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed")
print(q.price_usd, q.network, q.pay_to)   # Decimal('0.03') eip155:8453 0x973a...

# Free daily call (services with freeTier: true in the catalog)
r = client.call_free("token-price", address="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
print(r["data"])
```

Paid calls:

```python
import os
from bazaar402 import BazaarClient

# Prepaid credit token
client = BazaarClient(credit_token=os.environ["X402_CREDIT_TOKEN"])

# ...or your own wallet (needs bazaar402[wallet]); the key never leaves this process
client = BazaarClient(private_key=os.environ["AGENT_PRIVATE_KEY"], max_price_usd=0.10)

r = client.call("token-risk", address="0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed")
print(r["data"]["riskScore"])
print(client.last_settlement)  # decoded PAYMENT-RESPONSE (tx hash) after a wallet payment
```

- If both `credit_token` and `private_key` are set, the credit token is used. A
  short balance raises `PaymentRequiredError`; it does not fall back to the wallet.
- `max_price_usd` makes the client refuse to sign anything more expensive
  (`PriceTooHighError`, nothing signed).
- Parameters are keyword arguments. For names that aren't valid Python
  identifiers pass a dict: `client.call("some-service", {"from": "0x..."})`.
- Very long inputs (over ~4000 characters of query string) are sent as a JSON
  POST body to the same endpoint; the price and payment are unchanged.

### Errors

All errors subclass `bazaar402.BazaarError` and carry `.status` and `.body`.

| Exception | When |
| --- | --- |
| `NoPaymentMethodError` | `call()` with neither a credit token nor a private key |
| `BadRequestError` | 400, bad input. Not charged. |
| `PaymentRequiredError` | 402: payment needed, payment rejected, or credit token unknown/short. `.reason` holds the server's explanation; `.requirements` the decoded challenge. |
| `PriceTooHighError` | price above `max_price_usd`; nothing signed |
| `NotFoundError` | 404, unknown service id |
| `ConflictError` | 409, payment already used / in flight |
| `RateLimitError` | 429; `.retry_after` in seconds |
| `ServerError` | 5xx. The server does not settle an x402 payment on an error. |

### LangChain (optional)

```python
from bazaar402 import BazaarClient
from bazaar402.langchain import build_tools

tools = build_tools(BazaarClient(credit_token="ck_..."), services=["token-risk", "safe-to-send"])
```

Tool names, descriptions and parameter schemas come from
`https://402.com.tr/api/mcp?format=openai`. `langchain-core` is not a dependency
of this package; install the `[langchain]` extra or install it yourself.
`build_tools(..., free=True)` makes the tools use the free tier instead of paying.

## How signing works

Wallet payments are signed by Coinbase's official
[`x402`](https://pypi.org/project/x402/) Python package (`x402[evm,extensions]`),
the Python counterpart of the `@x402/*` packages the 402.com.tr server and the
`x402-bazaar-mcp` server use. This package does not implement any cryptography
itself. It registers the `exact` EVM scheme for Base mainnet (`eip155:8453`) only,
so it will not sign for other networks, and it attaches 402.com.tr's ERC-8021
builder code to the payment the same way the MCP server does (attribution only;
it doesn't change the price).

## Development

```bash
pip install -e ".[wallet,langchain,test]"
pytest              # offline tests: recorded real responses, nothing is paid
pytest -m live      # two read-only calls to 402.com.tr (a quote and a free call), nothing is paid
```

## Links

- Site: https://402.com.tr
- Catalog: https://402.com.tr/api/catalog
- OpenAPI: https://402.com.tr/openapi.json
- Source: https://github.com/sukrutkrdg/402/tree/main/sdk/python

MIT License.
