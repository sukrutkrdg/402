"""BazaarClient: call x402 Bazaar services from Python.

Protocol (as served by https://402.com.tr):

* Every service is ``GET {base_url}/api/x402/{service}?{params}``.
* A bare request answers ``402`` with an x402 v2 challenge in the
  ``PAYMENT-REQUIRED`` header (base64 JSON; the same object is in the body).
* Paying: sign the challenge (``exact`` scheme, EIP-3009 USDC authorization on
  Base, ``eip155:8453``) and repeat the request with a ``PAYMENT-SIGNATURE``
  header. Signing is done by Coinbase's official ``x402`` package; the server
  settles only after the service answered successfully (status < 400).
* Prepaid credits: send ``x-credit-token: ck_...``; the price is debited from
  the balance, no signature.
* Free tier: add ``free=1``; one full call per service per day per IP, then a
  preview. AI/metered services have no free tier and answer 402.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Mapping
from urllib.parse import quote as _urlquote
from urllib.parse import urlencode

import requests

from .errors import (
    BadRequestError,
    BazaarError,
    ConflictError,
    NoPaymentMethodError,
    NotFoundError,
    PaymentRequiredError,
    PriceTooHighError,
    RateLimitError,
    ServerError,
)

DEFAULT_BASE_URL = "https://402.com.tr"
BASE_MAINNET = "eip155:8453"
# USDC on Base (6 decimals). Prices are only converted to USD for this asset.
USDC_ON_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
USDC_DECIMALS = 6
# 402.com.tr's ERC-8021 builder code, echoed on x402 payments exactly as the
# x402-bazaar-mcp package does. Attribution only; it does not change the price.
BUILDER_CODE = "bc_pa0gqlv1"
# Longer query strings are sent as a JSON POST body instead (the server folds
# a POST body into the same GET path; the signed resource has no query string,
# so payment is unaffected).
_MAX_QUERY_CHARS = 4000


@dataclass(frozen=True)
class Quote:
    """The price of one call, read from the 402 challenge. Nothing was paid."""

    service: str
    amount: int
    """Price in the asset's smallest unit (USDC: 1 = $0.000001)."""
    price_usd: Decimal | None
    """`amount` in USD when the asset is USDC on Base, else None."""
    network: str
    asset: str
    pay_to: str
    scheme: str
    max_timeout_seconds: int | None
    requirements: dict = field(repr=False)
    """The full decoded x402 challenge (`x402Version`, `accepts`, `resource`, ...)."""


def _encode_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _merge_params(params: Mapping[str, Any] | None, kwargs: Mapping[str, Any]) -> dict[str, str]:
    merged: dict[str, Any] = {**(params or {}), **kwargs}
    return {k: _encode_value(v) for k, v in merged.items() if v is not None}


def decode_payment_required(resp: requests.Response) -> dict | None:
    """Return the decoded x402 challenge from a 402 response, or None."""
    header = resp.headers.get("PAYMENT-REQUIRED")
    if header:
        try:
            return json.loads(base64.b64decode(header))
        except (ValueError, TypeError):
            pass
    body = _json_or_none(resp)
    if isinstance(body, dict) and "accepts" in body and "x402Version" in body:
        return body
    return None


def _json_or_none(resp: requests.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return None


def _usd(amount: int, asset: str, network: str) -> Decimal | None:
    if network == BASE_MAINNET and asset.lower() == USDC_ON_BASE:
        return Decimal(amount) / (Decimal(10) ** USDC_DECIMALS)
    return None


def _base_accepts(requirements: dict) -> list[dict]:
    return [
        a
        for a in requirements.get("accepts") or []
        if a.get("network") == BASE_MAINNET and a.get("scheme") == "exact"
    ]


class _X402Payer:
    """Signs x402 payments with Coinbase's `x402` package. Imported lazily so
    credit-token and free-tier users never need the crypto dependencies."""

    def __init__(self, private_key: str) -> None:
        try:
            from eth_account import Account
            from x402 import x402ClientSync
            from x402.extensions.builder_code import BuilderCodeClientExtension
            from x402.http import x402HTTPClientSync
            from x402.mechanisms.evm import EthAccountSigner
            from x402.mechanisms.evm.exact import register_exact_evm_client
        except ImportError as e:  # pragma: no cover - depends on environment
            raise ImportError(
                "Paying with a private key needs the wallet extra: pip install 'bazaar402[wallet]'"
            ) from e

        account = Account.from_key(private_key)
        self.address: str = account.address
        client = x402ClientSync()
        # Base mainnet only: the client refuses to sign for any other network.
        register_exact_evm_client(client, EthAccountSigner(account), networks=BASE_MAINNET)
        client.register_extension(BuilderCodeClientExtension(BUILDER_CODE))
        self._client = client
        self._http = x402HTTPClientSync(client)

    def payment_headers(self, resp: requests.Response) -> dict[str, str]:
        required = self._http.get_payment_required_response(resp.headers.get, _json_or_none(resp))
        payload = self._client.create_payment_payload(required)
        return self._http.encode_payment_signature_header(payload)


class BazaarClient:
    """Client for https://402.com.tr.

    Args:
        private_key: hex EVM private key of a wallet holding USDC on Base. Used
            locally to sign x402 payments; never sent anywhere. Needs
            ``pip install 'bazaar402[wallet]'``.
        credit_token: a prepaid credit token (``ck_...``) bought via the
            ``buy-credits`` service. Takes precedence over ``private_key``.
        base_url: server root, default ``https://402.com.tr``.
        max_price_usd: refuse to sign any x402 payment above this price.
        timeout: per-request timeout in seconds.
        session: optional ``requests.Session`` (custom adapters, proxies, tests).
    """

    def __init__(
        self,
        private_key: str | None = None,
        credit_token: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        *,
        max_price_usd: float | Decimal | None = None,
        timeout: float = 60.0,
        session: requests.Session | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.credit_token = credit_token.strip() if credit_token else None
        self.max_price_usd = Decimal(str(max_price_usd)) if max_price_usd is not None else None
        self.timeout = timeout
        self.session = session or requests.Session()
        self._payer = _X402Payer(private_key) if private_key else None
        self.last_settlement: dict | None = None
        """Decoded ``PAYMENT-RESPONSE`` header of the last x402-paid call (tx hash etc.)."""

    def __repr__(self) -> str:
        mode = "credits" if self.credit_token else "wallet" if self._payer else "unpaid"
        return f"BazaarClient(base_url={self.base_url!r}, mode={mode!r})"

    @property
    def wallet_address(self) -> str | None:
        return self._payer.address if self._payer else None

    # ------------------------------------------------------------------ public

    def catalog(self) -> dict:
        """The full service catalog (``/api/catalog``). Free."""
        resp = self.session.get(f"{self.base_url}/api/catalog", timeout=self.timeout)
        self._raise_for(resp, "catalog")
        return resp.json()

    def quote(self, service: str, /, params: Mapping[str, Any] | None = None, **kwargs: Any) -> Quote:
        """Read the price of a call from its 402 challenge, without paying."""
        resp = self._send(service, _merge_params(params, kwargs), {})
        if resp.status_code != 402:
            self._raise_for(resp, service)
            raise BazaarError(
                f"{service} answered {resp.status_code} without asking for payment; no price to quote",
                resp.status_code,
                _json_or_none(resp),
            )
        req = decode_payment_required(resp)
        if not req or not req.get("accepts"):
            raise PaymentRequiredError(
                f"{service}: 402 without a readable x402 challenge", body=_json_or_none(resp)
            )
        accepts = _base_accepts(req) or list(req["accepts"])
        a = accepts[0]
        amount = int(a["amount"])
        return Quote(
            service=service,
            amount=amount,
            price_usd=_usd(amount, a.get("asset", ""), a.get("network", "")),
            network=a.get("network", ""),
            asset=a.get("asset", ""),
            pay_to=a.get("payTo", ""),
            scheme=a.get("scheme", ""),
            max_timeout_seconds=a.get("maxTimeoutSeconds"),
            requirements=req,
        )

    def call(self, service: str, /, params: Mapping[str, Any] | None = None, **kwargs: Any) -> dict:
        """Call a service and pay for it.

        Pays with the credit token if one is set (no fallback to the wallet if
        the balance is short), otherwise with an x402 signature from
        ``private_key``. Raises ``NoPaymentMethodError`` if neither is set.

        Parameters go in as keyword arguments, or as a ``params`` dict for
        names that are not valid Python identifiers (e.g. ``from``).

        Returns the JSON response, e.g. ``{"service": ..., "data": {...}, ...}``.
        """
        q = _merge_params(params, kwargs)
        if self.credit_token:
            resp = self._send(service, q, {"x-credit-token": self.credit_token})
            self._raise_for(resp, service)
            return resp.json()
        if self._payer is None:
            raise NoPaymentMethodError(
                "call() needs a payment method: pass credit_token='ck_...' or private_key='0x...' "
                "(pip install 'bazaar402[wallet]'), or use call_free() for the daily free call."
            )

        first = self._send(service, q, {})
        if first.status_code != 402:
            self._raise_for(first, service)
            return first.json()
        self._check_price(service, first)
        try:
            headers = self._payer.payment_headers(first)
        except Exception as e:  # x402 raises its own types (no matching scheme/network, ...)
            raise PaymentRequiredError(
                f"{service}: could not sign a payment for this challenge: {e}",
                body=_json_or_none(first),
                requirements=decode_payment_required(first),
            ) from e
        paid = self._send(service, q, headers)
        self._raise_for(paid, service)
        self.last_settlement = _decode_b64_json(paid.headers.get("PAYMENT-RESPONSE"))
        return paid.json()

    def call_free(self, service: str, /, params: Mapping[str, Any] | None = None, **kwargs: Any) -> dict:
        """Use the free tier (``?free=1``): one full call per service per day
        per IP, then a preview (``preview: True`` in the response). Services
        without a free tier raise ``PaymentRequiredError``."""
        q = _merge_params(params, kwargs)
        q["free"] = "1"
        resp = self._send(service, q, {})
        self._raise_for(resp, service)
        return resp.json()

    # ---------------------------------------------------------------- internal

    def _get_json(self, path: str, params: Mapping[str, str] | None = None) -> Any:
        resp = self.session.get(f"{self.base_url}{path}", params=params, timeout=self.timeout)
        self._raise_for(resp, path)
        return resp.json()

    def _send(self, service: str, params: dict[str, str], headers: dict[str, str]) -> requests.Response:
        if not service or "/" in service:
            raise ValueError(f"invalid service id: {service!r}")
        url = f"{self.base_url}/api/x402/{_urlquote(service)}"
        h = {"accept": "application/json", **headers}
        if len(urlencode(params)) > _MAX_QUERY_CHARS:
            # free=1 must stay in the query string; everything else goes in the body.
            query = {"free": params["free"]} if "free" in params else None
            body = {k: v for k, v in params.items() if k != "free"}
            return self.session.post(url, params=query, json=body, headers=h, timeout=self.timeout)
        return self.session.get(url, params=params, headers=h, timeout=self.timeout)

    def _check_price(self, service: str, resp: requests.Response) -> None:
        if self.max_price_usd is None:
            return
        req = decode_payment_required(resp) or {}
        for a in _base_accepts(req):
            usd = _usd(int(a["amount"]), a.get("asset", ""), a.get("network", ""))
            if usd is None or usd > self.max_price_usd:
                raise PriceTooHighError(
                    f"{service} asks {usd if usd is not None else a.get('amount')} "
                    f"(max_price_usd={self.max_price_usd}); nothing was signed",
                    402,
                    req,
                )

    @staticmethod
    def _raise_for(resp: requests.Response, what: str) -> None:
        status = resp.status_code
        if status < 400:
            return
        body = _json_or_none(resp)
        err = body.get("error") if isinstance(body, dict) else None
        msg = f"{what}: HTTP {status}" + (f" - {err}" if err else "")
        if status == 400:
            raise BadRequestError(msg, status, body)
        if status == 402:
            req = decode_payment_required(resp)
            reason = (req or {}).get("error") if req else None
            if not reason or reason == "Payment required":
                reason = err or reason
            if reason and reason not in msg:
                msg = f"{msg} ({reason})"
            raise PaymentRequiredError(msg, status, body, reason=reason, requirements=req)
        if status == 404:
            raise NotFoundError(msg, status, body)
        if status == 409:
            raise ConflictError(msg, status, body)
        if status == 429:
            ra = resp.headers.get("retry-after")
            try:
                retry_after = float(ra) if ra else None
            except ValueError:
                retry_after = None
            raise RateLimitError(msg, status, body, retry_after=retry_after)
        if status >= 500:
            raise ServerError(msg, status, body)
        raise BazaarError(msg, status, body)


def _decode_b64_json(value: str | None) -> dict | None:
    if not value:
        return None
    try:
        return json.loads(base64.b64decode(value))
    except (ValueError, TypeError):
        return None
