"use client";

import { useState } from "react";

type Tab = "cursor" | "claude" | "elizaos" | "python" | "langchain" | "crewai";

export default function AgentIntegrationModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("cursor");
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const siteUrl = "https://402.com.tr";

  const cursorSnippet = JSON.stringify(
    {
      mcpServers: {
        "x402-bazaar": {
          url: `${siteUrl}/api/mcp`,
        },
      },
    },
    null,
    2
  );

  const claudeSnippet = JSON.stringify(
    {
      mcpServers: {
        "x402-bazaar": {
          url: `${siteUrl}/api/mcp`,
        },
      },
    },
    null,
    2
  );

  const elizaosSnippet = `// ⚡ Official ElizaOS (ai16z) Action Plugin for x402 Bazaar
import { elizaX402Plugin } from "@x402/bazaar-sdk";

// Register in your ElizaOS character runtime:
runtime.registerPlugin(elizaX402Plugin);

// Your autonomous agent now automatically runs:
// - PRE_TRADE_CHECK (Honeypot, B20 Seizure, Slippage)
// - CHECK_AGENT_CREDIT (Agent FICO, Postpaid Credit Limit)
// - POLYMARKET_PREDICTION (Live Event Odds & Probability)`;

  const pythonSnippet = `# ⚡ 1-Line Python SDK (pip install x402-bazaar)
from x402 import Bazaar

bazaar = Bazaar(site_url="${siteUrl}")

# Run Pre-Trade Alpha Shield before any swap
shield = bazaar.call("pre-trade-alpha-shield", address="0x4ed4e862860bed51a9570b96d89af5e1b0efefed")
print("Verdict:", shield["verdict"]) # EXECUTE, CAUTION, or ABORT

# Check Agent Credit & FICO score on Base
credit = bazaar.call("agent-credit-score", address="0x50ec051c512da5047b41e8c78c2e6ba804be8505")
print("Agent FICO:", credit["creditScore"], "Tier:", credit["ratingTier"])`;

  const langchainSnippet = `# 1-line LangChain / OpenAI Tools integration for all 228 x402 Bazaar tools
import requests
from langchain_core.tools import StructuredTool

tools_manifest = requests.get("${siteUrl}/api/mcp?format=openai").json()["tools"]
print(f"Loaded {len(tools_manifest)} autonomous Web3 tools ready for LangChain/CrewAI")

# Example: Bind directly to any OpenAI / Claude chat model
# llm = ChatOpenAI(model="gpt-4o").bind_tools(tools_manifest)
`;

  const crewaiSnippet = `from crewai import Agent, Task, Crew
import requests

# Load full 228-tool capability set directly from x402 Bazaar
tools = requests.get("${siteUrl}/api/mcp?format=openai").json()["tools"]

market_agent = Agent(
    role="Base & DeFi Intelligence Specialist",
    goal="Screen token risk, verify agent provenance, and check Polymarket odds",
    backstory="Autonomous agent equipped with live x402 Bazaar onchain micro-tools",
    tools=tools,
    verbose=True
)
`;

  const currentCode =
    tab === "cursor"
      ? cursorSnippet
      : tab === "claude"
      ? claudeSnippet
      : tab === "elizaos"
      ? elizaosSnippet
      : tab === "python"
      ? pythonSnippet
      : tab === "langchain"
      ? langchainSnippet
      : crewaiSnippet;

  const handleCopy = () => {
    navigator.clipboard.writeText(currentCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-2xl rounded-2xl bg-[#0d111a] border border-white/10 shadow-2xl p-6 text-gray-200">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold tracking-tight text-white">⚡ Connect AI Agent</span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                228 Tools Active
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Plug x402 Bazaar into your IDE, desktop assistant, or agent framework in 1 click.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition"
          >
            ✕
          </button>
        </div>

        {/* Tab Selector */}
        <div className="flex items-center gap-2 mt-4 pb-2 border-b border-white/5 overflow-x-auto text-xs">
          <button
            onClick={() => setTab("cursor")}
            className={`px-3 py-1.5 rounded-lg font-medium transition cursor-pointer ${
              tab === "cursor" ? "bg-base-blue text-white shadow-md shadow-base-blue/20" : "text-gray-400 hover:text-white hover:bg-white/5"
            }`}
          >
            Cursor / Windsurf
          </button>
          <button
            onClick={() => setTab("claude")}
            className={`px-3 py-1.5 rounded-lg font-medium transition cursor-pointer ${
              tab === "claude" ? "bg-base-blue text-white shadow-md shadow-base-blue/20" : "text-gray-400 hover:text-white hover:bg-white/5"
            }`}
          >
            Claude Desktop
          </button>
          <button
            onClick={() => setTab("elizaos")}
            className={`px-3 py-1.5 rounded-lg font-medium transition cursor-pointer ${
              tab === "elizaos" ? "bg-purple-600 text-white shadow-md shadow-purple-600/20" : "text-gray-400 hover:text-white hover:bg-white/5"
            }`}
          >
            🤖 ElizaOS
          </button>
          <button
            onClick={() => setTab("python")}
            className={`px-3 py-1.5 rounded-lg font-medium transition cursor-pointer ${
              tab === "python" ? "bg-emerald-600 text-white shadow-md shadow-emerald-600/20" : "text-gray-400 hover:text-white hover:bg-white/5"
            }`}
          >
            🐍 Python SDK
          </button>
          <button
            onClick={() => setTab("langchain")}
            className={`px-3 py-1.5 rounded-lg font-medium transition cursor-pointer ${
              tab === "langchain" ? "bg-base-blue text-white shadow-md shadow-base-blue/20" : "text-gray-400 hover:text-white hover:bg-white/5"
            }`}
          >
            LangChain
          </button>
          <button
            onClick={() => setTab("crewai")}
            className={`px-3 py-1.5 rounded-lg font-medium transition cursor-pointer ${
              tab === "crewai" ? "bg-base-blue text-white shadow-md shadow-base-blue/20" : "text-gray-400 hover:text-white hover:bg-white/5"
            }`}
          >
            CrewAI / AutoGen
          </button>
        </div>

        {/* Instructions */}
        <div className="mt-3 text-xs text-gray-400">
          {tab === "cursor" && (
            <span>
              Add this to your project&apos;s <code className="text-sky-300 font-mono">.cursor/mcp.json</code> or Settings → MCP.
            </span>
          )}
          {tab === "claude" && (
            <span>
              Paste into your <code className="text-sky-300 font-mono">claude_desktop_config.json</code> under <code className="text-sky-300 font-mono">mcpServers</code>.
            </span>
          )}
          {tab === "elizaos" && (
            <span>
              Install <code className="text-purple-300 font-mono">@x402/bazaar-sdk</code> and register the action plugin directly into your ElizaOS character runtime.
            </span>
          )}
          {tab === "python" && (
            <span>
              Use the official lightweight Python client for LangChain, AutoGen, LlamaIndex, or raw scripts.
            </span>
          )}
          {tab === "langchain" && (
            <span>
              Load all 228 tool definitions in OpenAI function calling schema in a single HTTP request.
            </span>
          )}
          {tab === "crewai" && (
            <span>
              Equip your multi-agent crews with autonomous onchain verification and DeFi actions.
            </span>
          )}
        </div>

        {/* Code Snippet */}
        <div className="relative mt-2 rounded-xl bg-[#06080d] border border-white/10 p-4 font-mono text-xs overflow-x-auto text-sky-200">
          <pre>{currentCode}</pre>
          <button
            onClick={handleCopy}
            className="absolute top-3 right-3 px-3 py-1 rounded-lg text-xs font-sans font-semibold bg-white/10 hover:bg-white/20 text-white transition flex items-center gap-1.5 cursor-pointer shadow"
          >
            {copied ? <span className="text-emerald-400">✓ Copied!</span> : <span>📋 Copy</span>}
          </button>
        </div>

        {/* Footer info */}
        <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between text-xs text-gray-500">
          <span>Endpoint: <code className="text-gray-400">{siteUrl}/api/mcp</code></span>
          <span className="text-emerald-400">No API key required (1 free call/day per tool)</span>
        </div>
      </div>
    </div>
  );
}
