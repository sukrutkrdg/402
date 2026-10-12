import json
import requests
from typing import Dict, Any, List, Optional, Generator

DEFAULT_BASE_URL = "https://402.com.tr"
DEFAULT_BUILDER_CODE = "bc_pa0gqlv1"

class X402BazaarClient:
    """
    Client for interacting with x402 Bazaar APIs.
    Supports autonomous AI agent workflows on Base.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        fleet_token: Optional[str] = None,
        builder_code: str = DEFAULT_BUILDER_CODE,
        timeout: int = 15,
    ):
        self.base_url = base_url.rstrip("/")
        self.fleet_token = fleet_token
        self.builder_code = builder_code
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "x402-bazaar-py/1.0.0",
            "x-builder-code": self.builder_code,
        })
        if self.fleet_token:
            self.session.headers.update({"x-fleet-token": self.fleet_token})

    def status(self) -> Dict[str, Any]:
        """Fetch real-time network and service status from x402 Bazaar."""
        resp = self.session.get(f"{self.base_url}/api/status", timeout=self.timeout)
        resp.raise_for_status()
        return resp.json()

    def audit_token(self, token_address: str) -> Dict[str, Any]:
        """
        Audit a contract address on Base for honeypot, mint vulnerability, and liquidity risks.
        """
        resp = self.session.post(
            f"{self.base_url}/api/terminal/execute",
            json={"command": f"audit {token_address}"},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("result", {}).get("data", data)

    def get_arbitrage_spreads(self) -> List[Dict[str, Any]]:
        """
        Scan live liquidity pools across Aerodrome and Uniswap v3 on Base to discover spreads.
        """
        resp = self.session.get(f"{self.base_url}/api/radar", timeout=self.timeout)
        resp.raise_for_status()
        data = resp.json()
        return data.get("opportunities", [])

    def list_workflows(self) -> List[Dict[str, Any]]:
        """List active autonomous multi-step agent workflow recipes."""
        resp = self.session.get(f"{self.base_url}/api/workflows", timeout=self.timeout)
        resp.raise_for_status()
        data = resp.json()
        return data.get("recipes", [])

    def execute_workflow(self, recipe_id: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Execute an autonomous workflow recipe with scoped execution tokens."""
        resp = self.session.post(
            f"{self.base_url}/api/workflows",
            json={"action": "execute", "recipeId": recipe_id, "params": params or {}},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def stream_events(self) -> Generator[Dict[str, Any], None, None]:
        """
        Stream live real-time settlement telemetry, arbitrage, and sentinel events via Server-Sent Events.
        """
        headers = {"Accept": "text/event-stream"}
        with self.session.get(f"{self.base_url}/api/events/live", headers=headers, stream=True, timeout=60) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines(decode_unicode=True):
                if line and line.startswith("data: "):
                    raw_data = line[6:].strip()
                    try:
                        yield json.loads(raw_data)
                    except json.JSONDecodeError:
                        continue
