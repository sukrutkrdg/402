"""Live, read-only checks against https://402.com.tr. They never pay.

Run with: pytest -m live
"""

from __future__ import annotations

import pytest

from bazaar402 import BazaarClient

pytestmark = pytest.mark.live


def test_live_quote_paid_service():
    q = BazaarClient().quote("token-risk", address="0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed")
    assert q.network == "eip155:8453"
    assert q.amount > 0 and q.price_usd is not None


def test_live_call_free():
    # A full result on the first call of the day from this IP, a preview after.
    out = BazaarClient().call_free("token-price", address="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
    assert out["service"] == "token-price"
    assert out.get("freeTier") is True or out.get("preview") is True
    assert isinstance(out["data"], dict)
