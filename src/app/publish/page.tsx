"use client";

import { useState } from "react";
import Link from "next/link";

interface PublishResult {
  id: string;
  name: string;
  description: string;
  price: string;
  category: string;
  payoutAddress: string;
  proxyUrl: string;
  revenueShare: {
    publisher: string;
    platformFee: string;
  };
  mcpToolDeclaration: {
    name: string;
    description: string;
    endpoint: string;
  };
}

const CATEGORIES = [
  "AI & Inference",
  "Security & Risk",
  "Markets & Trading",
  "Onchain Forensics",
  "Social & Farcaster",
  "Compute & Data",
];

export default function PublishPage() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [targetUrl, setTargetUrl] = useState("");
  const [priceUsdc, setPriceUsdc] = useState("0.02");
  const [payoutAddress, setPayoutAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Revenue calculator state
  const [callsPerDay, setCallsPerDay] = useState(5000);
  const unitPrice = parseFloat(priceUsdc) || 0.02;
  const publisherDailyUsdc = (callsPerDay * unitPrice * 0.9).toFixed(2);
  const publisherMonthlyUsdc = (callsPerDay * unitPrice * 0.9 * 30).toFixed(2);

  function copyText(key: string, text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  async function handlePublish(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    if (!name.trim()) {
      setError("Please enter a service name.");
      return;
    }
    if (!description.trim() || description.length < 10) {
      setError("Please enter a detailed description (at least 10 characters).");
      return;
    }
    if (!/^https:\/\/[^ "]+$/.test(targetUrl.trim())) {
      setError("Please provide a valid HTTPS target URL.");
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(payoutAddress.trim())) {
      setError("Please enter a valid 0x… 40-hex Base payout wallet address.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          category,
          targetUrl: targetUrl.trim(),
          priceUsdc: `$${unitPrice.toFixed(2)}`,
          payoutAddress: payoutAddress.trim(),
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to publish service");
      }

      setResult(json.service);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-10 max-w-4xl mx-auto py-2">
      {/* Hero Header */}
      <div className="flex flex-col gap-3 text-center sm:text-left">
        <div className="flex items-center justify-center sm:justify-start gap-2">
          <span className="pill !px-3 !py-1 text-xs font-semibold border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
            💰 90% Publisher Revenue Share
          </span>
          <span className="pill !px-3 !py-1 text-xs font-semibold border-sky-500/30 bg-sky-500/10 text-sky-300">
            x402 + Base ERC-8021
          </span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
          Monetize Your API for AI Agents
        </h1>
        <p className="text-sm sm:text-base leading-relaxed text-gray-400 max-w-2xl">
          Turn any standard HTTP endpoint into an autonomous pay-per-call service. Autonomous agents pay you in
          USDC on Base using x402. <strong className="text-gray-200">Zero billing code, zero API keys to issue, zero chargebacks.</strong>
        </p>
      </div>

      {/* Comparison Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="card p-4 flex flex-col gap-2 border-white/10 bg-[#0d1017]">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">Traditional Stripe</div>
          <div className="text-xl font-bold text-red-400">2.9% + 30¢ Fee</div>
          <p className="text-xs text-gray-400 leading-relaxed">
            A 5¢ micropayment costs 31¢ in Stripe fees. Micro-metering for AI agents is mathematically impossible.
          </p>
        </div>
        <div className="card p-4 flex flex-col gap-2 border-white/10 bg-[#0d1017]">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">RapidAPI / SaaS</div>
          <div className="text-xl font-bold text-amber-400">20% Cut + Credit Cards</div>
          <p className="text-xs text-gray-400 leading-relaxed">
            Requires developers and agents to register credit cards and API keys. AI agents cannot sign up autonomously.
          </p>
        </div>
        <div className="card p-4 flex flex-col gap-2 border-emerald-500/30 bg-emerald-500/10">
          <div className="text-xs font-bold text-emerald-400 uppercase tracking-wider">x402 Bazaar</div>
          <div className="text-xl font-bold text-emerald-300">You Keep 90% USDC</div>
          <p className="text-xs text-emerald-100/80 leading-relaxed">
            Gasless EIP-3009 micro-payments directly to your Base wallet. Instant MCP server & machine catalog inclusion.
          </p>
        </div>
      </div>

      {/* Live Revenue Calculator */}
      <div className="card p-5 sm:p-6 flex flex-col gap-4 border-base-blue/30 bg-base-blue/10">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-white">📈 Autonomous Revenue Calculator</h2>
            <p className="text-xs text-gray-300">Estimate your earnings when AI agents call your endpoint over x402:</p>
          </div>
          <div className="text-right">
            <span className="font-mono text-xl sm:text-2xl font-black text-emerald-300">${publisherMonthlyUsdc}</span>
            <span className="text-[11px] text-gray-400 block">estimated USDC / month</span>
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <div className="flex justify-between text-xs text-gray-300">
            <span>Agent Calls per Day: <strong className="text-white font-mono">{callsPerDay.toLocaleString()}</strong></span>
            <span>Price per Call: <strong className="text-emerald-300 font-mono">${unitPrice.toFixed(2)}</strong></span>
          </div>
          <input
            type="range"
            min="500"
            max="100000"
            step="500"
            value={callsPerDay}
            onChange={(e) => setCallsPerDay(Number(e.target.value))}
            className="w-full accent-base-blue cursor-pointer"
          />
          <div className="flex justify-between text-[11px] text-gray-400 pt-1">
            <span>500 calls/day (~${(500 * unitPrice * 0.9 * 30).toFixed(0)}/mo)</span>
            <span>50k calls/day (~${(50000 * unitPrice * 0.9 * 30).toFixed(0)}/mo)</span>
            <span>100k calls/day (~${(100000 * unitPrice * 0.9 * 30).toFixed(0)}/mo)</span>
          </div>
        </div>
      </div>

      {/* Main Publishing Form */}
      <div className="card p-5 sm:p-7 flex flex-col gap-6 border-white/15 bg-[#0b0e15] shadow-2xl">
        <div className="border-b border-white/10 pb-4">
          <h2 className="text-lg font-bold text-white">Register Your API Endpoint</h2>
          <p className="text-xs text-gray-400">
            Fill in your service details. Once registered, x402 Bazaar acts as your transparent payment gateway.
          </p>
        </div>

        <form onSubmit={handlePublish} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-gray-300">Service Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. AI Token Sentiment Index"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 text-xs text-white placeholder-gray-500 outline-none focus:border-base-blue transition"
                required
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-gray-300">Category</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 text-xs text-white outline-none focus:border-base-blue transition cursor-pointer"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c} className="bg-gray-900">
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-gray-300">Detailed Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does your API do? (e.g. Computes 24h social sentiment and whale accumulation metrics for any Base token)."
              rows={2}
              className="w-full rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white placeholder-gray-500 outline-none focus:border-base-blue transition resize-none"
              required
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-gray-300">Target HTTPS Endpoint URL</span>
            <input
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://api.yourdomain.com/v1/predict"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 font-mono text-xs text-white placeholder-gray-500 outline-none focus:border-base-blue transition"
              required
            />
            <span className="text-[11px] text-gray-500">
              When an agent pays, x402 Bazaar forwards the request to this URL and streams your response back.
            </span>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-gray-300">Price per Call (USDC)</span>
              <div className="relative flex items-center">
                <span className="absolute left-3 text-xs text-gray-400">$</span>
                <input
                  type="number"
                  step="0.005"
                  min="0.005"
                  max="1.00"
                  value={priceUsdc}
                  onChange={(e) => setPriceUsdc(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/40 pl-7 pr-3 py-2.5 font-mono text-xs text-white outline-none focus:border-base-blue transition"
                  required
                />
              </div>
              <span className="text-[10px] text-gray-500">You receive 90% (${(unitPrice * 0.9).toFixed(3)} USDC)</span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-gray-300">Payout Base Address</span>
              <input
                value={payoutAddress}
                onChange={(e) => setPayoutAddress(e.target.value)}
                placeholder="0x… your Base wallet address"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3.5 py-2.5 font-mono text-xs text-white placeholder-gray-500 outline-none focus:border-base-blue transition"
                required
              />
              <span className="text-[10px] text-gray-500">Earnings settle in USDC on Base mainnet.</span>
            </label>
          </div>

          {error && (
            <div className="card p-3 border-red-500/30 bg-red-500/10 text-xs text-red-300">
              ⚠️ {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="btn-primary !py-3 text-xs sm:text-sm font-bold shadow-xl shadow-base-blue/25 disabled:opacity-40 cursor-pointer mt-2"
          >
            {busy ? "Registering on x402 Bazaar…" : "🚀 Publish & Monetize API"}
          </button>
        </form>

        {/* Success Output */}
        {result && (
          <div className="card flex flex-col gap-4 p-5 border-emerald-500/40 bg-emerald-500/10 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="flex items-center justify-between border-b border-emerald-500/20 pb-3">
              <div className="flex items-center gap-2">
                <span className="text-xl">🎉</span>
                <div>
                  <h3 className="text-sm font-bold text-white">{result.name} is Live!</h3>
                  <span className="text-[10px] text-emerald-300 font-mono">Service ID: {result.id}</span>
                </div>
              </div>
              <span className="pill !px-2.5 !py-0.5 text-xs font-bold border-emerald-400 bg-emerald-400/20 text-emerald-300">
                Active on x402
              </span>
            </div>

            <div className="flex flex-col gap-3 text-xs">
              <div>
                <div className="flex justify-between items-center text-gray-300 mb-1">
                  <span>Your Permanent x402 Proxy URL:</span>
                  <button
                    type="button"
                    onClick={() => copyText("proxy", result.proxyUrl)}
                    className="text-[11px] text-sky-400 hover:underline cursor-pointer"
                  >
                    {copied === "proxy" ? "✓ Copied" : "Copy URL"}
                  </button>
                </div>
                <div className="p-2.5 rounded-lg bg-black/60 font-mono text-emerald-300 break-all select-all border border-emerald-500/20">
                  {result.proxyUrl}
                </div>
              </div>

              <div>
                <div className="flex justify-between items-center text-gray-300 mb-1">
                  <span>How Agents Call Your API (cURL with x402):</span>
                  <button
                    type="button"
                    onClick={() =>
                      copyText(
                        "curl",
                        `curl "${result.proxyUrl}" -H "X-402-Payment: <EIP-3009 signature>"`
                      )
                    }
                    className="text-[11px] text-sky-400 hover:underline cursor-pointer"
                  >
                    {copied === "curl" ? "✓ Copied" : "Copy cURL"}
                  </button>
                </div>
                <pre className="p-2.5 rounded-lg bg-black/60 font-mono text-gray-300 overflow-x-auto border border-white/5 text-[11px]">
                  {`curl "${result.proxyUrl}" \\\n  -H "X-402-Payment: <EIP-3009 signature>"`}
                </pre>
              </div>

              <div className="pt-2 border-t border-emerald-500/20 flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-300">
                <span>Payout: <strong className="text-white">{result.price}</strong> per call (90% to {result.payoutAddress.slice(0, 6)}…{result.payoutAddress.slice(-4)})</span>
                <Link href="/agents" className="text-sky-400 hover:underline">
                  View Agent Integration Docs →
                </Link>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* FAQ / Info Section */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-gray-400">
        <div className="card p-4 border-white/10 bg-[#0d1017]">
          <h4 className="font-bold text-white mb-1.5">How does settlement work?</h4>
          <p className="leading-relaxed">
            When an agent submits an x402 payment, the EIP-3009 transfer is validated. Upon successful response from your API, 90% of the USDC is transferred directly to your Base payout wallet.
          </p>
        </div>
        <div className="card p-4 border-white/10 bg-[#0d1017]">
          <h4 className="font-bold text-white mb-1.5">How do agents discover my API?</h4>
          <p className="leading-relaxed">
            Published APIs are automatically listed in the machine-readable catalog at <code className="text-sky-300 font-mono">/api/catalog</code> and the <code className="text-sky-300 font-mono">x402-bazaar-mcp</code> Model Context Protocol registry used by Claude and Cursor.
          </p>
        </div>
      </div>
    </div>
  );
}
