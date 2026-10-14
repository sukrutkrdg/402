"""Offline tests. Responses marked "real" were recorded from https://402.com.tr
(see each fixture's `_recorded`); "synthetic" ones are built here and say so."""

from __future__ import annotations

import base64
import json
import time
from decimal import Decimal

import pytest

from bazaar402 import (
    BadRequestError,
    BazaarClient,
    NoPaymentMethodError,
    NotFoundError,
    PaymentRequiredError,
    PriceTooHighError,
    RateLimitError,
    ServerError,
)
from bazaar402.client import BUILDER_CODE

from conftest import fixture_response, load_fixture, make_response

TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"
CK = "ck_" + "ab" * 18


def _no_payment_headers(call: dict) -> None:
    h = {k.lower() for k in (call.get("headers") or {})}
    assert "payment-signature" not in h and "x-payment" not in h and "x-credit-token" not in h


# ------------------------------------------------------------------- quote


def test_quote_reads_price_from_real_402(fake):
    s = fake(fixture_response("token_risk_402.json"))
    q = BazaarClient(session=s).quote("token-risk", address=TOKEN)
    assert q.service == "token-risk"
    assert q.amount == 30000
    assert q.price_usd == Decimal("0.03")
    assert q.network == "eip155:8453"
    assert q.scheme == "exact"
    assert q.asset.lower() == "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
    assert q.pay_to == "0x973a31858f4d2125f48c880542da11a2796f12d6"
    assert q.requirements["x402Version"] == 2
    (call,) = s.calls
    assert call["method"] == "GET"
    assert call["url"] == "https://402.com.tr/api/x402/token-risk"
    assert call["params"] == {"address": TOKEN}
    _no_payment_headers(call)


def test_quote_falls_back_to_body_when_header_missing(fake):
    fx = load_fixture("token_risk_402.json")
    s = fake(make_response(402, fx["body"], {}))  # synthetic: header stripped
    assert BazaarClient(session=s).quote("token-risk", address=TOKEN).amount == 30000


# --------------------------------------------------------------- free tier


def test_call_free_sends_free_flag_and_no_payment(fake):
    s = fake(fixture_response("gas_oracle_free_200.json"))
    out = BazaarClient(session=s).call_free("gas-oracle")
    assert out["freeTier"] is True
    assert out["service"] == "gas-oracle"
    assert "baseFeeGwei" in out["data"]
    (call,) = s.calls
    assert call["params"] == {"free": "1"}
    _no_payment_headers(call)


def test_call_free_on_paid_only_service_raises_402(fake):
    s = fake(fixture_response("token_risk_402.json"))
    with pytest.raises(PaymentRequiredError) as ei:
        BazaarClient(session=s).call_free("token-risk", address=TOKEN)
    assert ei.value.requirements["accepts"][0]["amount"] == "30000"


# ------------------------------------------------------------ credit token


def test_credit_token_header_is_sent(fake):
    ok = {"service": "token-risk", "data": {"riskScore": 50}, "paidVia": "credits", "chargedUsd": 0.03, "creditBalanceUsd": 0.22}
    s = fake(make_response(200, ok, {"x-paid-via": "credits"}))  # synthetic success envelope
    out = BazaarClient(credit_token=CK, session=s).call("token-risk", address=TOKEN)
    assert out["paidVia"] == "credits"
    (call,) = s.calls
    assert call["headers"]["x-credit-token"] == CK
    assert "PAYMENT-SIGNATURE" not in call["headers"]
    assert call["params"] == {"address": TOKEN}


def test_credit_token_refused_raises_with_reason(fake):
    s = fake(fixture_response("token_risk_bad_credit_402.json"))
    with pytest.raises(PaymentRequiredError) as ei:
        BazaarClient(credit_token=CK, session=s).call("token-risk", address=TOKEN)
    assert ei.value.reason == "Invalid or unusable credit token"
    assert ei.value.body["balanceUsd"] == 0
    assert len(s.calls) == 1  # no fallback, no retry


def test_credit_token_wins_over_private_key_without_signing(fake):
    pytest.importorskip("x402")
    from eth_account import Account

    s = fake(make_response(200, {"data": {}}))
    BazaarClient(private_key=Account.create().key.hex(), credit_token=CK, session=s).call("gas-oracle")
    assert s.calls[0]["headers"]["x-credit-token"] == CK


def test_call_without_payment_method_raises_before_any_request(fake):
    s = fake()
    with pytest.raises(NoPaymentMethodError):
        BazaarClient(session=s).call("token-risk", address=TOKEN)
    assert s.calls == []


# ------------------------------------------------------------ x402 wallet


def _decode_sig_header(call: dict) -> dict:
    return json.loads(base64.b64decode(call["headers"]["PAYMENT-SIGNATURE"]))


def test_x402_payment_payload_shape_and_signature(fake):
    pytest.importorskip("x402")
    from eth_account import Account
    from eth_account.messages import encode_typed_data

    acct = Account.create()
    settle = base64.b64encode(json.dumps({"success": True, "transaction": "0xabc", "network": "eip155:8453"}).encode()).decode()
    s = fake(
        fixture_response("token_risk_402.json"),
        make_response(200, {"service": "token-risk", "data": {"riskScore": 50}}, {"PAYMENT-RESPONSE": settle}),  # synthetic
    )
    c = BazaarClient(private_key=acct.key.hex(), session=s)
    out = c.call("token-risk", address=TOKEN)
    assert out["data"]["riskScore"] == 50
    assert c.last_settlement == {"success": True, "transaction": "0xabc", "network": "eip155:8453"}

    first, paid = s.calls
    _no_payment_headers(first)
    assert paid["params"] == {"address": TOKEN}
    p = _decode_sig_header(paid)
    accepted = load_fixture("token_risk_402.json")["body"]["accepts"][0]

    assert p["x402Version"] == 2
    assert p["accepted"] == accepted
    assert p["resource"]["url"] == "https://402.com.tr/api/x402/token-risk"
    auth = p["payload"]["authorization"]
    assert auth["from"] == acct.address
    assert auth["to"].lower() == accepted["payTo"].lower()
    assert auth["value"] == accepted["amount"]
    assert int(auth["validBefore"]) > time.time()
    assert int(auth["validBefore"]) <= time.time() + accepted["maxTimeoutSeconds"] + 5
    assert len(bytes.fromhex(auth["nonce"][2:])) == 32
    assert BUILDER_CODE in p["extensions"]["builder-code"]["info"]["s"]

    # The signature is a valid EIP-3009 TransferWithAuthorization for USDC on Base.
    typed = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"},
                {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ],
        },
        "primaryType": "TransferWithAuthorization",
        "domain": {
            "name": accepted["extra"]["name"],
            "version": accepted["extra"]["version"],
            "chainId": 8453,
            "verifyingContract": accepted["asset"],
        },
        "message": {
            "from": auth["from"],
            "to": auth["to"],
            "value": int(auth["value"]),
            "validAfter": int(auth["validAfter"]),
            "validBefore": int(auth["validBefore"]),
            "nonce": bytes.fromhex(auth["nonce"][2:]),
        },
    }
    signer = Account.recover_message(encode_typed_data(full_message=typed), signature=p["payload"]["signature"])
    assert signer == acct.address


def test_x402_rejected_payment_surfaces_facilitator_reason(fake):
    pytest.importorskip("x402")
    from eth_account import Account

    fx = load_fixture("token_risk_402.json")
    req = json.loads(base64.b64decode(fx["headers"]["Payment-Required"]))
    # The exact reason 402.com.tr returned on 2026-10-14 for a zero-balance wallet.
    req["error"] = "invalid_payload: contract call failed: unable to call contract: execution reverted"
    rejected = make_response(402, {}, {"PAYMENT-REQUIRED": base64.b64encode(json.dumps(req).encode()).decode()})
    s = fake(fixture_response("token_risk_402.json"), rejected)
    with pytest.raises(PaymentRequiredError) as ei:
        BazaarClient(private_key=Account.create().key.hex(), session=s).call("token-risk", address=TOKEN)
    assert ei.value.reason.startswith("invalid_payload")
    assert len(s.calls) == 2


def test_max_price_refuses_to_sign(fake):
    pytest.importorskip("x402")
    from eth_account import Account

    s = fake(fixture_response("token_risk_402.json"))
    c = BazaarClient(private_key=Account.create().key.hex(), max_price_usd=0.01, session=s)
    with pytest.raises(PriceTooHighError):
        c.call("token-risk", address=TOKEN)
    assert len(s.calls) == 1


# ------------------------------------------------------------------ errors


def test_404_unknown_service(fake):
    s = fake(fixture_response("unknown_service_404.json"))
    with pytest.raises(NotFoundError) as ei:
        BazaarClient(credit_token=CK, session=s).call("no-such-service")
    assert ei.value.status == 404


@pytest.mark.parametrize(
    "status,headers,exc",
    [
        (400, {}, BadRequestError),
        (429, {"retry-after": "7"}, RateLimitError),
        (502, {}, ServerError),
        (503, {}, ServerError),
    ],
)
def test_typed_errors(fake, status, headers, exc):
    s = fake(make_response(status, {"error": "boom"}, headers))  # synthetic
    with pytest.raises(exc) as ei:
        BazaarClient(credit_token=CK, session=s).call("token-risk", address="nope")
    assert ei.value.status == status
    assert "boom" in str(ei.value)
    if exc is RateLimitError:
        assert ei.value.retry_after == 7.0


# ------------------------------------------------------------- misc / shape


def test_catalog(fake):
    s = fake(fixture_response("catalog_200.json"))
    cat = BazaarClient(session=s).catalog()
    assert {x["id"] for x in cat["services"]} == {"token-risk", "gas-oracle", "ai-translate"}
    assert s.calls[0]["url"] == "https://402.com.tr/api/catalog"


def test_params_dict_for_keyword_names_and_value_encoding(fake):
    s = fake(make_response(200, {"data": {}}))
    BazaarClient(credit_token=CK, session=s).call("x", {"from": "0x1"}, list=True, limit=5, skip=None)
    assert s.calls[0]["params"] == {"from": "0x1", "list": "true", "limit": "5"}


def test_long_input_goes_in_post_body(fake):
    s = fake(make_response(200, {"data": {}}))
    BazaarClient(session=s).call_free("ai-summarize", text="x" * 5000)
    (call,) = s.calls
    assert call["method"] == "POST"
    assert call["json"] == {"text": "x" * 5000}
    assert call["params"] == {"free": "1"}


def test_base_url_and_service_validation(fake):
    s = fake(make_response(200, {"data": {}}))
    BazaarClient(credit_token=CK, base_url="http://localhost:3000/", session=s).call("gas-oracle")
    assert s.calls[0]["url"] == "http://localhost:3000/api/x402/gas-oracle"
    with pytest.raises(ValueError):
        BazaarClient(credit_token=CK, session=s).call("../admin")


def test_repr_never_leaks_secrets():
    r = repr(BazaarClient(credit_token=CK))
    assert CK not in r and "credits" in r
