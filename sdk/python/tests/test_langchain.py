from __future__ import annotations

import pytest

from bazaar402 import BazaarClient

from conftest import fixture_response, make_response

pytest.importorskip("langchain_core")

from bazaar402.langchain import build_tools  # noqa: E402

CK = "ck_" + "ab" * 18


def test_build_tools_from_real_openai_spec(fake):
    s = fake(fixture_response("mcp_openai_200.json"))
    tools = build_tools(BazaarClient(credit_token=CK, session=s))
    assert {t.name for t in tools} == {"token_risk", "gas_oracle", "ai_translate"}
    assert s.calls[0]["url"] == "https://402.com.tr/api/mcp"
    assert s.calls[0]["params"] == {"format": "openai"}


def test_tool_invocation_calls_the_service(fake):
    s = fake(
        fixture_response("mcp_openai_200.json"),
        make_response(200, {"service": "token-risk", "data": {"riskScore": 50}}),  # synthetic
    )
    (tool,) = build_tools(BazaarClient(credit_token=CK, session=s), services=["token-risk"])
    out = tool.invoke({"address": "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"})
    assert out["data"]["riskScore"] == 50
    call = s.calls[1]
    assert call["url"] == "https://402.com.tr/api/x402/token-risk"
    assert call["params"] == {"address": "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"}
    assert call["headers"]["x-credit-token"] == CK
