"use client";

import { useState } from "react";
import type { ServiceMeta } from "./Marketplace";

interface ServiceCodeModalProps {
  service: ServiceMeta | null;
  params: Record<string, string>;
  isOpen: boolean;
  onClose: () => void;
}

export default function ServiceCodeModal({
  service,
  params,
  isOpen,
  onClose,
}: ServiceCodeModalProps) {
  const [tab, setTab] = useState<"ts" | "py" | "mcp" | "curl">("ts");
  const [copied, setCopied] = useState(false);

  if (!isOpen || !service) return null;

  const siteUrl = "https://402.com.tr";
  const endpointUrl = `${siteUrl}/api/x402/${service.id}`;

  // Build clean params object (fallback to placeholders if empty)
  const queryParams: Record<string, string> = {};
  for (const p of service.params) {
    const val = (params[p.name] ?? "").trim();
    queryParams[p.name] = val || (p.placeholder && !p.placeholder.includes("…") ? p.placeholder : "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed");
  }

  const qs = new URLSearchParams(queryParams).toString();
  const fullUrl = `${endpointUrl}${qs ? `?${qs}` : ""}`;

  // TypeScript Snippet
  const tsSnippet = `// ⚡ Call ${service.name} from TypeScript / Node.js
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

// 1. Setup payment client (Base L2 USDC)
const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as \`0x\${string}\`);
const paidFetch = wrapFetchWithPayment(fetch, { account });

// 2. Call x402 Bazaar endpoint
async function query${service.id.replace(/[^a-zA-Z0-9]/g, "")}() {
  const response = await paidFetch("${fullUrl}", {
    headers: { "Accept": "application/json" }
  });
  
  if (!response.ok) {
    throw new Error(\`Request failed: \${response.status}\`);
  }
  
  const data = await response.json();
  console.log("Decision Result:", data);
  return data;
}

query${service.id.replace(/[^a-zA-Z0-9]/g, "")}();`;

  // Python Snippet
  const pySnippet = `# ⚡ Call ${service.name} from Python
import requests
from eth_account import Account
# pip install x402-client requests

endpoint = "${endpointUrl}"
params = ${JSON.stringify(queryParams, null, 4)}

# Automatic HTTP 402 micro-payment handler
res = requests.get(endpoint, params=params, headers={"Accept": "application/json"})

if res.status_code == 200:
    data = res.json()
    print("✓ Success:", data)
elif res.status_code == 402:
    print("x402 Payment Required:", res.headers.get("x402-payment-required"))
    # Settle using x402-client on Base mainnet
`;

  // MCP Tool Config
  const mcpSnippet = `// Add this tool to Claude Desktop / Cursor / Windsurf mcpServers config:
{
  "mcpServers": {
    "x402-bazaar": {
      "url": "${siteUrl}/api/mcp"
    }
  }
}

// Or invoke the direct tool schema:
{
  "name": "x402_${service.id.replace(/-/g, "_")}",
  "description": "${service.description.replace(/"/g, '\\"')}",
  "parameters": {
    "type": "object",
    "properties": {
${service.params.map((p) => `      "${p.name}": { "type": "string", "description": "${p.label}" }`).join(",\n")}
    },
    "required": [${service.params.filter((p) => p.required).map((p) => `"${p.name}"`).join(", ")}]
  }
}`;

  // cURL
  const curlSnippet = `curl -X GET "${fullUrl}" \\
  -H "Accept: application/json"`;

  const snippets = {
    ts: tsSnippet,
    py: pySnippet,
    mcp: mcpSnippet,
    curl: curlSnippet,
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(snippets[tab]).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card max-w-2xl w-full border border-white/15 bg-[#0b0e14] p-6 shadow-2xl flex flex-col gap-4 max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-base-blue/20 text-xl">
              {service.icon}
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">{service.name}</h2>
                <span className="font-mono text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  {service.price}
                </span>
              </div>
              <p className="text-xs text-gray-400">Endpoint: <code>/api/x402/{service.id}</code></p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-white/10 hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* Tab selection */}
        <div className="flex flex-wrap gap-1.5 border-b border-white/10 pb-3">
          {(
            [
              { id: "ts", label: "TypeScript / Node" },
              { id: "py", label: "Python" },
              { id: "mcp", label: "MCP Tool" },
              { id: "curl", label: "cURL" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${
                tab === t.id
                  ? "bg-base-blue text-white shadow-md shadow-base-blue/20"
                  : "text-gray-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Code Box */}
        <div className="relative flex-1 overflow-auto rounded-xl border border-white/10 bg-black/60 p-4">
          <button
            onClick={handleCopy}
            className="absolute top-3 right-3 rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-gray-200 hover:bg-white/20 hover:text-white transition cursor-pointer flex items-center gap-1.5"
          >
            {copied ? "✓ Copied!" : "📋 Copy"}
          </button>
          <pre className="font-mono text-xs leading-relaxed text-sky-200 overflow-x-auto pr-16">
            <code>{snippets[tab]}</code>
          </pre>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-xs text-gray-400 pt-1">
          <span>Gasless Base L2 settlement · Builder Code attributed</span>
          <button onClick={onClose} className="btn-ghost !py-1.5 !px-4 text-xs cursor-pointer">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
