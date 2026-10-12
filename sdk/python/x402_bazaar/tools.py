"""
AI Agent Framework Adapters (LangChain & CrewAI) for x402 Bazaar.
"""

from typing import Optional, Type, Any
from .client import X402BazaarClient

try:
    from langchain_core.tools import BaseTool
    from pydantic import BaseModel, Field

    class AuditTokenInput(BaseModel):
        address: str = Field(description="Contract address on Base to audit for honeypot or rugpull risk")

    class X402AuditTool(BaseTool):
        name: str = "x402_audit_token"
        description: str = "Audit any Base token address for honeypots, rugpull risk, and liquidity health via x402 Bazaar."
        args_schema: Type[BaseModel] = AuditTokenInput
        client: Optional[X402BazaarClient] = None

        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            if not self.client:
                self.client = X402BazaarClient()

        def _run(self, address: str) -> str:
            res = self.client.audit_token(address)
            return str(res)

        async def _arun(self, address: str) -> str:
            return self._run(address)


    class ArbitrageInput(BaseModel):
        filter_profitable: bool = Field(default=True, description="Whether to only return opportunities with positive estimated net profit")

    class X402ArbitrageTool(BaseTool):
        name: str = "x402_arbitrage_radar"
        description: str = "Scan live Base liquidity pools across Aerodrome and Uniswap v3 to find arbitrage opportunities."
        args_schema: Type[BaseModel] = ArbitrageInput
        client: Optional[X402BazaarClient] = None

        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            if not self.client:
                self.client = X402BazaarClient()

        def _run(self, filter_profitable: bool = True) -> str:
            res = self.client.get_arbitrage_spreads()
            return str(res)

        async def _arun(self, filter_profitable: bool = True) -> str:
            return self._run(filter_profitable)

except ImportError:
    # Fallback placeholder classes if langchain-core is not installed
    class X402AuditTool:
        def __init__(self, *args, **kwargs):
            raise ImportError("Please install langchain-core: pip install 'x402-bazaar[langchain]'")

    class X402ArbitrageTool:
        def __init__(self, *args, **kwargs):
            raise ImportError("Please install langchain-core: pip install 'x402-bazaar[langchain]'")
