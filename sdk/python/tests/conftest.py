"""Offline test harness: a fake requests.Session that replays recorded responses."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import requests

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def make_response(status: int, body: Any = None, headers: dict | None = None, url: str = "https://402.com.tr/x") -> requests.Response:
    r = requests.Response()
    r.status_code = status
    r._content = json.dumps(body).encode("utf-8") if body is not None else b""
    r.headers.update(headers or {})
    if body is not None:
        r.headers.setdefault("Content-Type", "application/json")
    r.url = url
    r.encoding = "utf-8"
    return r


def fixture_response(name: str) -> requests.Response:
    fx = load_fixture(name)
    return make_response(fx["status"], fx["body"], fx["headers"])


class FakeSession:
    """Records every request and answers from a queue. Never touches the network."""

    def __init__(self, *responses: requests.Response) -> None:
        self.queue = list(responses)
        self.calls: list[dict] = []

    def _answer(self, method: str, url: str, **kw: Any) -> requests.Response:
        self.calls.append({"method": method, "url": url, **kw})
        if not self.queue:
            raise AssertionError(f"unexpected request: {method} {url}")
        return self.queue.pop(0)

    def get(self, url: str, **kw: Any) -> requests.Response:
        return self._answer("GET", url, **kw)

    def post(self, url: str, **kw: Any) -> requests.Response:
        return self._answer("POST", url, **kw)


@pytest.fixture
def fake():
    def factory(*responses: requests.Response) -> FakeSession:
        return FakeSession(*responses)

    return factory
