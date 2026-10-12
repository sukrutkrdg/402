"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { ServiceMeta } from "./Marketplace";
import MultiAgentSandbox from "./MultiAgentSandbox";

export default function PlaygroundClient({ services }: { services: ServiceMeta[] }) {
  const [mode, setMode] = useState<"single" | "multiagent">("single");
  const [selectedId, setSelectedId] = useState<string>("polymarket-odds");
  const [search, setSearch] = useState("");
  const [activeCodeTab, setActiveCodeTab] = useState<"json" | "curl" | "python" | "typescript">("json");
  const [params, setParams] = useState<Record<string, string>>({ query: "fed" });
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<unknown>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // Filter services by search
  const filtered = useMemo(() => {
    if (!search) return services;
    const s = search.toLowerCase();
    return services.filter(
      (svc) =>
        svc.name.toLowerCase().includes(s) ||
        svc.id.toLowerCase().includes(s) ||
        svc.category.toLowerCase().includes(s)
    );
  }, [services, search]);

  const selected = useMemo(() => {
    return services.find((s) => s.id === selectedId) || services[0];
  }, [services, selectedId]);

  // Handle service change
  const handleSelectService = (svc: ServiceMeta) => {
    setSelectedId(svc.id);
    // Initialize default params from placeholders
    const defaults: Record<string, string> = {};
    for (const p of svc.params) {
      defaults[p.name] = p.placeholder && !p.placeholder.includes("…") ? p.placeholder : "";
    }
    // Specific real defaults for common services
    if (svc.id === "polymarket-odds") defaults.query = "fed";
    if (svc.id === "agent-provenance") defaults.address = "0x973a31858f4d2125f48c880542da11a2796f12d6";
    if (svc.id === "token-risk" || svc.id === "deep-dd") defaults.address = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
    if (svc.id === "clanker-token-audit") defaults.address = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
    if (svc.id === "pre-trade-bundle") defaults.address = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
    if (svc.id === "base-dex-spread") defaults.token = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
    if (svc.id === "agent-session-guard") defaults.signer = "0x973a31858f4d2125f48c880542da11a2796f12d6";
    if (svc.id === "farcaster-social-velocity") defaults.query = "HIGHER";
    setParams(defaults);
    setResponse(null);
    setStatusText(null);
    setLatencyMs(null);
  };

  const executeCall = async () => {
    if (!selected) return;
    setLoading(true);
    setResponse(null);
    setStatusText("Running on Base mainnet...");
    const started = Date.now();

    try {
      let res = await fetch("/api/buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serviceId: selected.id, params }),
      });
      let json = await res.json().catch(() => ({}));

      // If server buyer is disabled or gated, fall back to free trial
      if (!res.ok && (res.status === 403 || res.status === 401)) {
        const qs = new URLSearchParams({ ...params, free: "1" }).toString();
        const freeRes = await fetch(`/api/x402/${selected.id}?${qs}`);
        if (freeRes.ok) {
          res = freeRes;
          json = await freeRes.json().catch(() => ({}));
        }
      }

      const ms = Date.now() - started;
      setLatencyMs(ms);
      if (!res.ok) {
        setStatusText(`HTTP ${res.status}: ${json.error || "Execution failed"}`);
        setResponse(json);
      } else {
        setStatusText(`HTTP 200 OK (${ms}ms)`);
        setResponse(json.result?.data ?? json.data ?? json);
      }
    } catch (e) {
      setLatencyMs(Date.now() - started);
      setStatusText(`Error: ${(e as Error).message}`);
      setResponse({ error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };

  // Generate snippets
  const queryStr = new URLSearchParams(params).toString();
  const fullUrl = `https://402.com.tr/api/x402/${selected?.id}${queryStr ? `?${queryStr}` : ""}`;

  const curlCode = `curl -X GET "${fullUrl}" \\
  -H "Accept: application/json"`;

  const pythonCode = `import requests

url = "${fullUrl}"
headers = {"Accept": "application/json"}

# For unlimited paid calls, pass an x-credit-token or pay over x402:
# headers["x-credit-token"] = "your_credit_token"

res = requests.get(url, headers=headers)
data = res.json()
print(data)`;

  const tsCode = `import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as \`0x\${string}\`);
const client = new x402Client();
client.register("eip155:8453", new ExactEvmScheme(account));

const payingFetch = wrapFetchWithPayment(fetch, client);
const res = await payingFetch("${fullUrl}");
const data = await res.json();
console.log(data);`;

  const copyCode = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* Top Banner */}
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-white">Interactive API Playground</h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20">
              225 Services Live
            </span>
          </div>
          <p className="text-sm text-gray-400 mt-1">
            Test any x402 Bazaar micro-service live, inspect output schemas, and generate production code snippets.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/agents"
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 text-gray-300 border border-white/10 transition"
          >
            Agent Documentation →
          </Link>
          <Link
            href="/"
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-base-blue/20 hover:bg-base-blue/30 text-sky-300 border border-base-blue/30 transition"
          >
            ← Back to Marketplace
          </Link>
        </div>
      </div>

      {/* Mode Switcher Tabs */}
      <div className="flex items-center gap-2 mb-6 bg-[#0a0d14] p-1.5 rounded-xl border border-white/10 w-fit">
        <button
          onClick={() => setMode("single")}
          className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition cursor-pointer ${
            mode === "single"
              ? "bg-blue-600 text-white shadow-md shadow-blue-500/20"
              : "text-gray-400 hover:text-white"
          }`}
        >
          <span>⚡ Single API Runner</span>
        </button>
        <button
          onClick={() => setMode("multiagent")}
          className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition cursor-pointer ${
            mode === "multiagent"
              ? "bg-blue-600 text-white shadow-md shadow-blue-500/20"
              : "text-gray-400 hover:text-white"
          }`}
        >
          <span>🤖 Multi-Agent EIP-3009 Sandbox</span>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            NEW
          </span>
        </button>
      </div>

      {mode === "multiagent" ? (
        <MultiAgentSandbox services={services} />
      ) : (
        /* Grid: Left Service Selector & Form | Right Console Output */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Services list & Input Form */}
        <div className="lg:col-span-5 space-y-4">
          {/* Service Search & Picker */}
          <div className="rounded-xl bg-[#0d111a] border border-white/10 p-4">
            <label className="text-xs font-semibold text-gray-300 uppercase tracking-wider block mb-2">
              Select Service
            </label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${services.length} services (e.g. polymarket, risk, swap)...`}
              className="w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-sky-500"
            />
            <div className="mt-2 max-h-48 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
              {filtered.slice(0, 30).map((svc) => (
                <button
                  key={svc.id}
                  onClick={() => handleSelectService(svc)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition cursor-pointer ${
                    selected?.id === svc.id
                      ? "bg-base-blue/20 text-sky-300 border border-base-blue/30 font-medium"
                      : "text-gray-400 hover:text-white hover:bg-white/5"
                  }`}
                >
                  <span className="truncate">
                    {svc.icon} {svc.name}
                  </span>
                  <span className="font-mono text-[10px] text-emerald-400 shrink-0 ml-2">{svc.price}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Parameters Form */}
          {selected && (
            <div className="rounded-xl bg-[#0d111a] border border-white/10 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
                    <span>{selected.icon}</span>
                    <span>{selected.name}</span>
                  </h3>
                  <p className="text-xs text-gray-400 line-clamp-1 mt-0.5">{selected.tagline}</p>
                </div>
                <span className="font-mono text-xs font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  {selected.price}
                </span>
              </div>

              {selected.params.length === 0 ? (
                <div className="text-xs text-gray-500 py-3 text-center border border-dashed border-white/10 rounded-lg">
                  No parameters required for this endpoint.
                </div>
              ) : (
                <div className="space-y-2.5 pt-2 border-t border-white/5">
                  {selected.params.map((p) => (
                    <div key={p.name}>
                      <label className="text-[11px] font-medium text-gray-300 flex items-center justify-between mb-1">
                        <span>{p.label}</span>
                        {p.required && <span className="text-[10px] text-sky-400">required</span>}
                      </label>
                      <input
                        type="text"
                        value={params[p.name] ?? ""}
                        onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}
                        placeholder={p.placeholder || p.name}
                        className="w-full rounded-lg bg-black/40 border border-white/10 px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-sky-500"
                      />
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={executeCall}
                disabled={loading}
                className="w-full mt-3 py-2 px-4 rounded-lg bg-gradient-to-r from-base-blue to-[#0042d6] hover:brightness-110 text-white text-xs font-semibold tracking-wide shadow-md shadow-base-blue/20 transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <span className="animate-spin text-sm">⏳</span>
                    <span>Executing on Base...</span>
                  </>
                ) : (
                  <>
                    <span>⚡ Run Live Query</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Right Column: Console / Output Viewer */}
        <div className="lg:col-span-7 rounded-xl bg-[#0a0d14] border border-white/10 overflow-hidden flex flex-col h-[560px]">
          {/* Top Bar with Tabs & Status */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-[#0e131d] border-b border-white/10 text-xs">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setActiveCodeTab("json")}
                className={`px-2.5 py-1 rounded font-medium transition cursor-pointer ${
                  activeCodeTab === "json" ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"
                }`}
              >
                JSON Response
              </button>
              <button
                onClick={() => setActiveCodeTab("curl")}
                className={`px-2.5 py-1 rounded font-medium transition cursor-pointer ${
                  activeCodeTab === "curl" ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"
                }`}
              >
                cURL
              </button>
              <button
                onClick={() => setActiveCodeTab("python")}
                className={`px-2.5 py-1 rounded font-medium transition cursor-pointer ${
                  activeCodeTab === "python" ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"
                }`}
              >
                Python
              </button>
              <button
                onClick={() => setActiveCodeTab("typescript")}
                className={`px-2.5 py-1 rounded font-medium transition cursor-pointer ${
                  activeCodeTab === "typescript" ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"
                }`}
              >
                TypeScript
              </button>
            </div>

            <div className="flex items-center gap-2.5">
              {statusText && (
                <span
                  className={`font-mono text-[11px] ${
                    statusText.includes("200") ? "text-emerald-400" : "text-amber-400"
                  }`}
                >
                  {statusText}
                </span>
              )}
              {latencyMs !== null && (
                <span className="font-mono text-[10px] text-gray-500">
                  {latencyMs}ms
                </span>
              )}
              <button
                onClick={() =>
                  copyCode(
                    activeCodeTab === "json"
                      ? JSON.stringify(response ?? {}, null, 2)
                      : activeCodeTab === "curl"
                      ? curlCode
                      : activeCodeTab === "python"
                      ? pythonCode
                      : tsCode
                  )
                }
                className="text-[11px] px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-gray-300 transition cursor-pointer"
              >
                {copied ? "✓ Copied" : "Copy"}
              </button>
            </div>
          </div>

          {/* Console Area */}
          <div className="p-4 flex-1 overflow-auto font-mono text-xs text-sky-200 bg-[#06080d]">
            {activeCodeTab === "json" && (
              response ? (
                <pre className="whitespace-pre-wrap">{JSON.stringify(response, null, 2)}</pre>
              ) : (
                <div className="h-full flex items-center justify-center text-gray-600 text-center">
                  <div>
                    <span className="text-2xl block mb-2">⚡</span>
                    <span>Click &quot;Run Live Query&quot; on the left to execute.</span>
                  </div>
                </div>
              )
            )}
            {activeCodeTab === "curl" && <pre className="whitespace-pre-wrap">{curlCode}</pre>}
            {activeCodeTab === "python" && <pre className="whitespace-pre-wrap">{pythonCode}</pre>}
            {activeCodeTab === "typescript" && <pre className="whitespace-pre-wrap">{tsCode}</pre>}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
