"""Optional LangChain helper: one StructuredTool per x402 Bazaar service.

``langchain-core`` is NOT a dependency of this package; install it yourself or
use ``pip install 'bazaar402[langchain]'``. Tool definitions come from the
server's OpenAI-format tool list (``/api/mcp?format=openai``), so names,
descriptions and JSON-schema parameters match what the MCP server exposes.
"""

from __future__ import annotations

from typing import Any, Callable, Iterable

from .client import BazaarClient


def _service_id(tool_name: str) -> str:
    # The server derives tool names from service ids by replacing "-" with "_".
    return tool_name.replace("_", "-")


def build_tools(
    client: BazaarClient,
    services: Iterable[str] | None = None,
    *,
    free: bool = False,
) -> list:
    """Return LangChain ``StructuredTool`` objects for the catalog.

    Args:
        client: the BazaarClient that will make (and pay for) the calls.
        services: optional service ids to include (e.g. ``["token-risk"]``);
            default is every service, which is a long list for one agent.
        free: if True the tools use ``call_free`` (daily free call, then a
            preview) instead of paying with the client's credit token / wallet.
    """
    try:
        from langchain_core.tools import StructuredTool
    except ImportError as e:
        raise ImportError(
            "bazaar402.langchain needs langchain-core: pip install 'bazaar402[langchain]'"
        ) from e

    wanted = set(services) if services is not None else None
    spec = client._get_json("/api/mcp", {"format": "openai"})
    invoke = client.call_free if free else client.call

    def make(service: str) -> Callable[..., Any]:
        def run(**kwargs: Any) -> Any:
            return invoke(service, kwargs)

        return run

    tools = []
    for entry in spec.get("tools", []):
        fn = entry.get("function") or {}
        name = fn.get("name")
        if not name:
            continue
        service = _service_id(name)
        if wanted is not None and service not in wanted:
            continue
        tools.append(
            StructuredTool(
                name=name,
                description=fn.get("description") or service,
                args_schema=fn.get("parameters") or {"type": "object", "properties": {}},
                func=make(service),
            )
        )
    return tools
