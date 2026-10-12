"use client";

import { useState } from "react";
import Link from "next/link";

interface SdkExample {
  title: string;
  lang: string;
  install: string;
  code: string;
}

const EXAMPLES: Record<string, SdkExample> = {
  cli: {
    title: "Official Agent CLI (Zero Install)",
    lang: "bash",
    install: "# No install needed, run directly with npx:",
    code: `# Check Base relayer cluster health & attribution
npx x402-bazaar status

# Run atomic pre-trade security & honeypot audit ($0.05 USDC)
npx x402-bazaar audit 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed

# Calculate cross-DEX spread between Aerodrome & Uniswap v3 ($0.02 USDC)
npx x402-bazaar spread 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed

# Inspect catalog of 143+ onchain micro-services
npx x402-bazaar catalog`,
  },
  typescript: {
    title: "TypeScript / Node.js SDK",
    lang: "typescript",
    install: "npm install @sukrutkrdg/plugin-x402-bazaar viem",
    code: `import { x402BazaarClient } from "@sukrutkrdg/plugin-x402-bazaar";

// Initialize keyless client on Base Mainnet
const bazaar = new x402BazaarClient({
  network: "base",
  builderCode: "bc_pa0gqlv1"
});

async function runSafetyPipeline(tokenAddress: string) {
  // 1. Pre-Trade Security & Tax Probe (0.05 USDC settled via EIP-3009)
  const audit = await bazaar.call("pre-trade-bundle", { token: tokenAddress });
  
  if (audit.isHoneypot || audit.sellTax > 5.0) {
    console.warn("Blocked unsafe token! Decision receipt:", audit.receiptUrl);
    return;
  }
  
  // 2. Gasless swap routing with verified safety receipt
  const swap = await bazaar.call("swap-intent", {
    tokenOut: tokenAddress,
    amountUsdc: 50
  });
  
  console.log("Swap completed! Tx:", swap.txHash);
}`,
  },
  python: {
    title: "Python SDK / httpx",
    lang: "python",
    install: "pip install httpx eth-account",
    code: `import httpx

BASE_URL = "https://402.com.tr"

def audit_token(token_address: str):
    headers = {"Accept": "application/json"}
    
    # FastPass Credit Token or raw EIP-3009 permit header
    # headers["x-credit-token"] = "your_prepaid_credit_token"
    
    response = httpx.get(
        f"{BASE_URL}/api/x402/pre-trade-bundle",
        params={"token": token_address},
        headers=headers,
        timeout=10.0
    )
    
    if response.status_code == 402:
        print("Payment required. EIP-3009 terms:", response.headers.get("x-payment-response"))
        
    return response.json()

print(audit_token("0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"))`,
  },
  agentkit: {
    title: "Coinbase AgentKit (Official Action Provider)",
    lang: "typescript",
    install: "npm install @coinbase/agentkit",
    code: `import { AgentKit, x402ActionProvider } from "@coinbase/agentkit";

// Official PR #1557 registers x402 Bazaar out-of-the-box
const agentKit = await AgentKit.from({
  actionProviders: [
    x402ActionProvider({
      // Bazaar is registered in KNOWN_FACILITATORS
      allowDynamicServiceRegistration: true
    })
  ]
});

// Autonomous agent query:
// AgentKit automatically routes to https://402.com.tr
const services = await agentKit.runAction("discover_x402_services", {
  facilitator: "bazaar",
  keyword: "honeypot",
  maxUsdcPrice: 0.10
});`,
  },
  elizaos: {
    title: "ElizaOS v2 Plugin",
    lang: "typescript",
    install: "npm install @sukrutkrdg/plugin-x402-bazaar",
    code: `import { x402BazaarPlugin } from "@sukrutkrdg/plugin-x402-bazaar";

// Add to your Eliza character configuration:
export const character = {
  name: "BazaarGuard",
  plugins: [x402BazaarPlugin],
  // Available actions:
  // - PRE_TRADE_CHECK
  // - SWAP_ON_BASE
  // - CROSS_CHAIN_SWAP
  // - X402_BAZAAR_CALL
};`,
  },
};

export default function SdkPage() {
  const [activeTab, setActiveTab] = useState<string>("cli");
  const [copiedCode, setCopiedCode] = useState(false);

  const currentExample = EXAMPLES[activeTab];

  const handleCopy = (text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "1.5rem 1rem 4rem" }}>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: "2rem" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.3rem 0.85rem",
            borderRadius: 999,
            backgroundColor: "rgba(0, 82, 255, 0.12)",
            border: "1px solid rgba(0, 82, 255, 0.35)",
            color: "#60a5fa",
            fontSize: "0.82rem",
            fontWeight: 700,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            marginBottom: "0.85rem",
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#0052ff", boxShadow: "0 0 10px #0052ff" }} />
          Developer Tooling • CLI & SDK
        </div>
        <h1
          style={{
            fontSize: "clamp(1.9rem, 4vw, 2.75rem)",
            fontWeight: 800,
            margin: "0 0 0.6rem",
            letterSpacing: "-0.025em",
            background: "linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, #94a3b8 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          x402 Bazaar Developer SDK & CLI Hub
        </h1>
        <p style={{ color: "#94a3b8", fontSize: "1.05rem", maxWidth: 680, margin: "0 auto 1.5rem" }}>
          Integrate 143+ pay-per-call onchain services into autonomous agents, command-line pipelines, and trading algorithms with zero API keys.
        </p>

        <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => handleCopy("npx x402-bazaar status")}
            style={{
              padding: "0.6rem 1.25rem",
              borderRadius: 8,
              backgroundColor: "#0052ff",
              color: "#fff",
              fontWeight: 700,
              fontSize: "0.9rem",
              border: "none",
              cursor: "pointer",
              fontFamily: "monospace",
            }}
          >
            {copiedCode ? "✓ Copied!" : "npx x402-bazaar status 📋"}
          </button>
          <Link
            href="/terminal"
            style={{
              padding: "0.6rem 1.25rem",
              borderRadius: 8,
              backgroundColor: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.15)",
              color: "#e2e8f0",
              fontWeight: 600,
              fontSize: "0.9rem",
              textDecoration: "none",
            }}
          >
            💻 Open Agent Terminal
          </Link>
          <Link
            href="/workflows"
            style={{
              padding: "0.6rem 1.25rem",
              borderRadius: 8,
              backgroundColor: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.15)",
              color: "#e2e8f0",
              fontWeight: 600,
              fontSize: "0.9rem",
              textDecoration: "none",
            }}
          >
            ⚡ Agent Workflows
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          justifyContent: "center",
          flexWrap: "wrap",
          marginBottom: "1.5rem",
        }}
      >
        {[
          { id: "cli", label: "💻 CLI (npx)" },
          { id: "typescript", label: "🟦 TypeScript / Node" },
          { id: "python", label: "🐍 Python" },
          { id: "agentkit", label: "🔵 Coinbase AgentKit" },
          { id: "elizaos", label: "⚡ ElizaOS v2" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              setActiveTab(tab.id);
              setCopiedCode(false);
            }}
            style={{
              padding: "0.55rem 1.1rem",
              borderRadius: 8,
              border: activeTab === tab.id ? "1px solid rgba(0, 82, 255, 0.6)" : "1px solid rgba(255,255,255,0.08)",
              backgroundColor: activeTab === tab.id ? "rgba(0, 82, 255, 0.2)" : "rgba(15, 23, 42, 0.6)",
              color: activeTab === tab.id ? "#60a5fa" : "#94a3b8",
              fontWeight: 700,
              fontSize: "0.85rem",
              cursor: "pointer",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Code Card */}
      <div
        style={{
          backgroundColor: "#030712",
          border: "1px solid rgba(0, 82, 255, 0.35)",
          borderRadius: 14,
          boxShadow: "0 10px 40px rgba(0, 82, 255, 0.12)",
          overflow: "hidden",
          marginBottom: "2.5rem",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "0.85rem 1.25rem",
            backgroundColor: "rgba(255,255,255,0.02)",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <div>
            <strong style={{ color: "#f8fafc", fontSize: "0.95rem" }}>{currentExample.title}</strong>
            <span style={{ marginLeft: "0.75rem", fontSize: "0.78rem", color: "#64748b", fontFamily: "monospace" }}>
              {currentExample.install}
            </span>
          </div>
          <button
            onClick={() => handleCopy(currentExample.code)}
            style={{
              padding: "0.35rem 0.85rem",
              borderRadius: 6,
              border: "1px solid rgba(255,255,255,0.15)",
              backgroundColor: "rgba(255,255,255,0.05)",
              color: copiedCode ? "#10b981" : "#94a3b8",
              fontSize: "0.78rem",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            {copiedCode ? "✓ Copied to Clipboard" : "Copy Code"}
          </button>
        </div>

        {/* Code Content */}
        <pre
          style={{
            margin: 0,
            padding: "1.25rem",
            overflowX: "auto",
            color: "#7dd3fc",
            fontSize: "0.82rem",
            lineHeight: 1.55,
            fontFamily: "var(--font-geist-mono, monospace)",
          }}
        >
          <code>{currentExample.code}</code>
        </pre>
      </div>

      {/* Feature Comparison Matrix */}
      <div
        style={{
          backgroundColor: "rgba(15, 23, 42, 0.6)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 14,
          padding: "1.5rem",
        }}
      >
        <h3 style={{ margin: "0 0 1rem", fontSize: "1.15rem", color: "#f8fafc" }}>
          Integration Method Comparison
        </h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", textAlign: "left", fontSize: "0.82rem", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", color: "#94a3b8" }}>
                <th style={{ padding: "0.75rem 0.5rem" }}>Method</th>
                <th style={{ padding: "0.75rem 0.5rem" }}>Authentication</th>
                <th style={{ padding: "0.75rem 0.5rem" }}>Avg Latency</th>
                <th style={{ padding: "0.75rem 0.5rem" }}>Best For</th>
              </tr>
            </thead>
            <tbody style={{ color: "#cbd5e1" }}>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <td style={{ padding: "0.75rem 0.5rem", fontWeight: 700, color: "#60a5fa" }}>x402-bazaar CLI</td>
                <td style={{ padding: "0.75rem 0.5rem" }}>Zero Keys (Instant Terminal)</td>
                <td style={{ padding: "0.75rem 0.5rem" }}>~38ms</td>
                <td style={{ padding: "0.75rem 0.5rem" }}>Quick testing, scripts, CI/CD jobs</td>
              </tr>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <td style={{ padding: "0.75rem 0.5rem", fontWeight: 700, color: "#10b981" }}>Coinbase AgentKit</td>
                <td style={{ padding: "0.75rem 0.5rem" }}>Native Action Provider (PR #1557)</td>
                <td style={{ padding: "0.75rem 0.5rem" }}>~42ms</td>
                <td style={{ padding: "0.75rem 0.5rem" }}>Autonomous Base agents, CDP wallets</td>
              </tr>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <td style={{ padding: "0.75rem 0.5rem", fontWeight: 700, color: "#a855f7" }}>ElizaOS v2 Plugin</td>
                <td style={{ padding: "0.75rem 0.5rem" }}>5 Pre-built Actions (PR #40)</td>
                <td style={{ padding: "0.75rem 0.5rem" }}>~45ms</td>
                <td style={{ padding: "0.75rem 0.5rem" }}>Social bot swarms, crypto trading bots</td>
              </tr>
              <tr>
                <td style={{ padding: "0.75rem 0.5rem", fontWeight: 700, color: "#f59e0b" }}>Direct EIP-3009 REST</td>
                <td style={{ padding: "0.75rem 0.5rem" }}>USDC transferWithAuthorization</td>
                <td style={{ padding: "0.75rem 0.5rem" }}>Sub-second auth / 2s block</td>
                <td style={{ padding: "0.75rem 0.5rem" }}>Custom backend microservices, smart contracts</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
