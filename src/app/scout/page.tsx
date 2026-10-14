"use client";

import { useState } from "react";
import Link from "next/link";

interface MatchResult {
  serviceId: string;
  name: string;
  description: string;
  priceUsdc: number;
  priceCents: number;
  confidenceScore: number;
  matchReason: string;
  endpointUrl: string;
  categoryTags: string[];
  sampleRequest: {
    method: string;
    url: string;
  };
}

interface ResolveResponse {
  status: string;
  query: string;
  resolved: boolean;
  bestMatch: MatchResult | null;
  alternatives: MatchResult[];
  directExecutionSnippet: {
    curl: string;
    typescript: string;
  } | null;
  autonomousDiscoveryNote: string;
}

const PRESET_QUERIES = [
  "detect honeypot & rug pull on new token",
  "polymarket live election odds & probability",
  "dex spread arbitrage between Aerodrome and Uniswap",
  "cross-chain bridge swap from NEAR to Base",
  "scrape webpage url to clean text",
  "check if wallet address is poisoned or sanctioned",
];

export default function ScoutPage() {
  const [query, setQuery] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<ResolveResponse | null>(null);

  const handleSearch = async (searchQuery: string) => {
    const q = searchQuery.trim();
    if (!q) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/discovery/resolve?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setResult(data);
    } catch (err) {
      console.error("Resolve error:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto space-y-12">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
            AUTONOMOUS AGENT SERVICE SCOUT · BASE MAINNET
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 via-teal-300 to-amber-300">
            Find & Buy Any Service with x402
          </h1>
          <p className="max-w-3xl mx-auto text-base sm:text-lg text-slate-400 leading-relaxed">
            Whatever an AI agent needs—forensic security audits, predictive odds, cross-chain bridges, or niche data feeds—our autonomous semantic resolver matches the exact endpoint with a 0-gas EIP-3009 settlement payload.
          </p>
        </div>

        {/* Semantic Search Box */}
        <div className="p-8 rounded-3xl bg-slate-900/90 border border-slate-800 space-y-4 shadow-2xl">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSearch(query);
            }}
            className="flex flex-col sm:flex-row gap-3"
          >
            <div className="relative flex-1">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Describe your agent's need in natural language (e.g. check if token is a rug, get polymarket odds...)"
                className="w-full px-4 py-3.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-400 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="px-6 py-3.5 rounded-xl font-bold text-sm bg-gradient-to-r from-cyan-500 to-teal-400 text-slate-950 hover:opacity-95 transition shadow-lg shadow-cyan-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? "Resolving Intent..." : "🎯 Resolve & Buy"}
            </button>
          </form>

          {/* Preset Chips */}
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <span className="text-xs text-slate-500 font-medium">Quick Prompts:</span>
            {PRESET_QUERIES.map((preset) => (
              <button
                key={preset}
                onClick={() => {
                  setQuery(preset);
                  handleSearch(preset);
                }}
                className="text-xs px-2.5 py-1 rounded-lg bg-slate-950 hover:bg-slate-800 text-slate-400 border border-slate-800 transition text-left"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>

        {/* Search Results Display */}
        {result && (
          <div className="space-y-6 animate-fadeIn">
            {result.bestMatch ? (
              <div className="p-8 rounded-3xl bg-slate-900 border border-cyan-500/40 shadow-xl space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2.5 py-0.5 rounded-full font-bold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                        {result.bestMatch.confidenceScore}% CONFIDENCE MATCH
                      </span>
                      <span className="text-xs text-slate-500 font-mono">
                        ID: {result.bestMatch.serviceId}
                      </span>
                    </div>
                    <h2 className="text-2xl font-bold text-slate-100 mt-2">{result.bestMatch.name}</h2>
                    <p className="text-xs text-slate-400 mt-1">{result.bestMatch.matchReason}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-slate-500">Per-Call Price</span>
                    <p className="text-2xl font-mono font-bold text-emerald-400">${result.bestMatch.priceUsdc.toFixed(2)} USDC</p>
                    <span className="text-[11px] text-slate-400">({result.bestMatch.priceCents}¢ / call via EIP-3009)</span>
                  </div>
                </div>

                <p className="text-sm text-slate-300">{result.bestMatch.description}</p>

                {/* Direct Execution Code Tabs */}
                {result.directExecutionSnippet && (
                  <div className="space-y-3">
                    <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                      Autonomous One-Line Execution Snippets:
                    </span>
                    <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 font-mono text-xs text-slate-300 overflow-x-auto space-y-3">
                      <div>
                        <span className="text-amber-400 block mb-1"># 1. cURL (Direct HTTP 402):</span>
                        <code>{result.directExecutionSnippet.curl}</code>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-800">
                  <div className="flex flex-wrap gap-1.5">
                    {result.bestMatch.categoryTags.map((tag) => (
                      <span key={tag} className="text-xs px-2 py-0.5 rounded bg-slate-950 text-slate-400 font-mono">
                        #{tag}
                      </span>
                    ))}
                  </div>
                  <a
                    href={`${result.bestMatch.endpointUrl}?free=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-4 py-2 rounded-xl text-xs font-bold bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition"
                  >
                    Test Free Trial Call ↗
                  </a>
                </div>
              </div>
            ) : (
              <div className="p-8 rounded-3xl bg-slate-900/60 border border-slate-800 text-center space-y-3">
                <span className="text-3xl">🔍</span>
                <h3 className="text-lg font-bold text-slate-200">No Direct Match in 225 Services</h3>
                <p className="text-xs text-slate-400 max-w-lg mx-auto">
                  {result.autonomousDiscoveryNote}
                </p>
              </div>
            )}

            {/* Alternatives */}
            {result.alternatives.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-400">Related Alternative Feeds:</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {result.alternatives.map((alt) => (
                    <div key={alt.serviceId} className="p-4 rounded-xl bg-slate-900/60 border border-slate-800/80">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-slate-200">{alt.name}</span>
                        <span className="text-xs font-mono font-bold text-emerald-400">${alt.priceUsdc.toFixed(2)}</span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1 line-clamp-2">{alt.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Bottom CTA */}
        <div className="flex flex-wrap items-center justify-center gap-4 pt-6 border-t border-slate-900">
          <Link
            href="/"
            className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 transition"
          >
            Browse the full marketplace
          </Link>
          <Link
            href="/agents"
            className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 transition"
          >
            Connect your agent (MCP)
          </Link>
        </div>
      </div>
    </div>
  );
}
