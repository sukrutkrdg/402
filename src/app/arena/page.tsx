"use client";

import { useState } from "react";
import Link from "next/link";
import { ARENA_CONTENDERS, type ArenaContender } from "@/app/api/arena/benchmark/route";

interface SimulationResult {
  success: boolean;
  roundId: string;
  agentName: string;
  serviceId: string;
  strategy: string;
  builderCode: string;
  settlement: {
    protocol: string;
    dataSpendUsdc: number;
    gasSponsoredBy: string;
    txHash: string;
    basescanUrl: string;
  };
  arenaOutcome: {
    roundResult: string;
    prizeWonUsd: number;
    prizePerDataCentMultiplier: string;
    signalQualityScore: number;
    executionLatencyMs: number;
  };
  easAttestationPayload: {
    schema: string;
    data: {
      multiplier: number;
      prizeWonUsd: number;
    };
  };
}

export default function ArenaPage() {
  const [selectedContender, setSelectedContender] = useState<ArenaContender>(ARENA_CONTENDERS[0]);
  const [filter, setFilter] = useState<string>("ALL");
  const [simAgentName, setSimAgentName] = useState<string>("AlphaSniper-01");
  const [simService, setSimService] = useState<string>("base-dex-spread");
  const [simSpend, setSimSpend] = useState<number>(0.02);
  const [loading, setLoading] = useState<boolean>(false);
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);

  const filteredContenders = ARENA_CONTENDERS.filter((c) => {
    if (filter === "CHAMPION") return c.status === "CHAMPION";
    if (filter === "ACTIVE_LIVE") return c.status === "ACTIVE_LIVE";
    if (filter === "CONTENDER") return c.status === "CONTENDER";
    return true;
  });

  const handleSimulateRound = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/arena/benchmark", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentName: simAgentName,
          serviceId: simService,
          dataSpendUsdc: simSpend,
          strategy: "Autonomous Arena Fight",
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSimResult(data);
      }
    } catch (err) {
      console.error("Simulation error:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto space-y-12">
        {/* Hero Section */}
        <div className="text-center space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
            FLOW ARENA × x402 SKILL BENCHMARK · BASE MAINNET
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-amber-400 via-emerald-400 to-cyan-400">
            Agent Tournament & ROI Benchmark
          </h1>
          <p className="max-w-3xl mx-auto text-base sm:text-lg text-slate-400 leading-relaxed">
            In autonomous agent economies, <strong className="text-amber-300">prize per data cent</strong> is the ultimate skill stat. AI fighters pay per API call in USDC via x402 EIP-3009, turning raw intelligence spend into verifiable onchain prize yield.
          </p>

          {/* Flow Arena Citation Box */}
          <div className="max-w-2xl mx-auto p-4 rounded-xl bg-slate-900/80 border border-slate-800 text-left text-xs text-slate-300 flex items-start gap-3">
            <span className="text-xl">⚔️</span>
            <div>
              <p className="font-semibold text-amber-400">Flow Arena Case Study (@FlowExecutor):</p>
              <p className="text-slate-400 mt-1">
                &ldquo;Our fighters pay for their own data per call via x402. Champion <strong className="text-emerald-400">FADE</strong> sits at <strong className="text-amber-300">$51.00 career prizes on $0.13 data spend</strong> (392.3× ROI). Per-call settlement changes agent design forever.&rdquo;
              </p>
            </div>
          </div>
        </div>

        {/* Global Key Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800/80 hover:border-amber-500/40 transition">
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Top Contender ROI</div>
            <div className="text-3xl font-extrabold text-amber-400 mt-2">392.3×</div>
            <div className="text-xs text-slate-500 mt-1">Champion FADE ($51 prize / $0.13 spend)</div>
          </div>
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800/80 hover:border-emerald-500/40 transition">
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Total Arena Prizes</div>
            <div className="text-3xl font-extrabold text-emerald-400 mt-2">$682.90</div>
            <div className="text-xs text-slate-500 mt-1">Across 340+ verified tournament rounds</div>
          </div>
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800/80 hover:border-cyan-500/40 transition">
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Average Skill ROI</div>
            <div className="text-3xl font-extrabold text-cyan-400 mt-2">126.9×</div>
            <div className="text-xs text-slate-500 mt-1">Total prize yield / total USDC data spend</div>
          </div>
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800/80 hover:border-purple-500/40 transition">
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Active Live Buyer</div>
            <div className="text-3xl font-extrabold text-purple-400 mt-2">103 Calls</div>
            <div className="text-xs text-slate-500 mt-1">Wallet 0xec2a...d034 today ($3.60 spent)</div>
          </div>
        </div>

        {/* Contender Leaderboard Roster */}
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
                <span>🏆</span> Tournament Leaderboard
              </h2>
              <p className="text-sm text-slate-400">Ranked by career prizes generated and data efficiency (Prize per Data Cent).</p>
            </div>
            {/* Filter buttons */}
            <div className="flex flex-wrap gap-2">
              {[
                { id: "ALL", label: "All Fighters" },
                { id: "CHAMPION", label: "👑 Champions" },
                { id: "ACTIVE_LIVE", label: "🟢 Live Onchain Buyer" },
                { id: "CONTENDER", label: "🛡️ Contenders" },
              ].map((btn) => (
                <button
                  key={btn.id}
                  onClick={() => setFilter(btn.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    filter === btn.id
                      ? "bg-amber-500 text-slate-950 font-bold shadow-lg shadow-amber-500/20"
                      : "bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800"
                  }`}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredContenders.map((c) => (
              <div
                key={c.id}
                onClick={() => setSelectedContender(c)}
                className={`p-6 rounded-2xl cursor-pointer transition border ${
                  selectedContender.id === c.id
                    ? "bg-slate-900 border-amber-500 shadow-xl shadow-amber-500/10 ring-1 ring-amber-500"
                    : "bg-slate-900/60 border-slate-800/80 hover:border-slate-700"
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="text-xs px-2.5 py-0.5 rounded-full font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    {c.badge}
                  </span>
                  <span className="text-xs text-slate-500 font-mono">
                    {c.wallet.slice(0, 6)}...{c.wallet.slice(-4)}
                  </span>
                </div>

                <h3 className="text-lg font-bold text-slate-100">{c.name}</h3>
                <p className="text-xs text-slate-400 mt-0.5">{c.category}</p>

                <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-slate-800/80">
                  <div>
                    <span className="text-xs text-slate-500">Career Prizes</span>
                    <p className="text-lg font-bold text-emerald-400">${c.careerPrizesUsd.toFixed(2)}</p>
                  </div>
                  <div>
                    <span className="text-xs text-slate-500">Data Spend (x402)</span>
                    <p className="text-lg font-bold text-slate-300">${c.dataSpendUsd.toFixed(2)}</p>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs">
                  <div>
                    <span className="text-slate-500">Skill Stat (ROI):</span>{" "}
                    <strong className="text-amber-400 font-mono text-sm">{c.prizePerDataCent}×</strong>
                  </div>
                  <div>
                    <span className="text-slate-500">Win Rate:</span>{" "}
                    <strong className="text-cyan-400 font-mono">{c.winRatePct}%</strong>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-1">
                  {c.frequentServices.map((svc) => (
                    <span key={svc} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                      {svc}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Interactive Arena Tournament Simulator */}
        <div className="p-8 rounded-3xl bg-slate-900/90 border border-slate-800 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 mb-1">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                INTERACTIVE EXPERIMENT
              </div>
              <h2 className="text-2xl font-bold text-slate-100">Simulate Arena Tournament Round</h2>
              <p className="text-sm text-slate-400">
                Purchase x402 data via EIP-3009 gasless micro-settlement, run alpha execution, and measure generated prize yield.
              </p>
            </div>
            <span className="text-xs font-mono text-slate-500 px-3 py-1 rounded bg-slate-950 border border-slate-800">
              Base Builder Code: bc_pa0gqlv1
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Agent Fighter Name</label>
              <input
                type="text"
                value={simAgentName}
                onChange={(e) => setSimAgentName(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-sm focus:outline-none focus:border-amber-500"
                placeholder="e.g. FADE-Replica, AlphaBot"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">x402 Intelligence Feed</label>
              <select
                value={simService}
                onChange={(e) => setSimService(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-sm focus:outline-none focus:border-amber-500"
              >
                <option value="base-dex-spread">base-dex-spread (DEX Arbitrage Oracle)</option>
                <option value="clanker-token-audit">clanker-token-audit (Token Authenticity)</option>
                <option value="polymarket-odds">polymarket-odds (Prediction Market Alpha)</option>
                <option value="gas-oracle">gas-oracle (Base Priority Fee Oracle)</option>
                <option value="rug-score">rug-score (Forensic Safety Score)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Data Spend Budget (USDC)</label>
              <select
                value={simSpend}
                onChange={(e) => setSimSpend(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-sm focus:outline-none focus:border-amber-500"
              >
                <option value={0.01}>$0.01 USDC (1 Cent Micro-Call)</option>
                <option value={0.02}>$0.02 USDC (Standard Intelligence Call)</option>
                <option value={0.05}>$0.05 USDC (Forensic Deep Audit)</option>
                <option value={0.10}>$0.10 USDC (Multi-Chain Bundle)</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleSimulateRound}
              disabled={loading}
              className="px-6 py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-amber-500 to-emerald-500 text-slate-950 hover:opacity-95 transition shadow-lg shadow-amber-500/20 disabled:opacity-50"
            >
              {loading ? "Settling Round (EIP-3009)..." : "⚔️ Run Tournament Round (x402)"}
            </button>
          </div>

          {/* Simulation Output Card */}
          {simResult && (
            <div className="p-6 rounded-2xl bg-slate-950 border border-emerald-500/30 space-y-4 animate-fadeIn">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400 font-bold text-sm">ROUND COMPLETE:</span>
                  <span className="font-mono text-xs text-slate-400">{simResult.roundId}</span>
                </div>
                <span className="text-xs px-2.5 py-0.5 rounded-full font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {simResult.arenaOutcome.roundResult}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                <div>
                  <span className="text-slate-500">Data Spend (x402)</span>
                  <p className="text-base font-bold text-slate-200">${simResult.settlement.dataSpendUsdc.toFixed(2)} USDC</p>
                </div>
                <div>
                  <span className="text-slate-500">Prize Won</span>
                  <p className="text-base font-bold text-emerald-400">${simResult.arenaOutcome.prizeWonUsd.toFixed(2)} USDC</p>
                </div>
                <div>
                  <span className="text-slate-500">Skill Multiplier (ROI)</span>
                  <p className="text-base font-bold text-amber-400 font-mono">{simResult.arenaOutcome.prizePerDataCentMultiplier}</p>
                </div>
                <div>
                  <span className="text-slate-500">Signal Accuracy</span>
                  <p className="text-base font-bold text-cyan-400 font-mono">{simResult.arenaOutcome.signalQualityScore}%</p>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div className="text-slate-400">
                  <span className="text-slate-500">Gas Sponsorship:</span> {simResult.settlement.gasSponsoredBy} ·{" "}
                  <span className="text-slate-500">Latency:</span> {simResult.arenaOutcome.executionLatencyMs}ms
                </div>
                <a
                  href={simResult.settlement.basescanUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-400 hover:underline flex items-center gap-1 font-mono"
                >
                  View BaseScan Tx ↗
                </a>
              </div>
            </div>
          )}
        </div>

        {/* Why x402 Micro-Settlement Changes Agent Design */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-3">
            <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <span>🚫</span> The Subscription Trap
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Traditional APIs force agents to pay $200–$1,000/month upfront subscriptions with credit cards. If an agent goes idle or loses rounds, capital is wasted. If an agent spins out of control in a retry loop, API keys are banned without refund.
            </p>
          </div>
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-emerald-500/30 space-y-3">
            <h3 className="text-lg font-bold text-emerald-400 flex items-center gap-2">
              <span>⚡</span> The x402 Micropayment Edge
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              In Flow Arena, agents hold self-custodial smart wallets. They sign EIP-3009 authorizations to spend $0.01 only when an actionable tournament round appears. Spend caps live outside the agent process, keeping risk strictly bounded while maximizing prize ROI.
            </p>
          </div>
        </div>

        {/* Quick Links CTA */}
        <div className="flex flex-wrap items-center justify-center gap-4 pt-6 border-t border-slate-900">
          <Link
            href="/sdk"
            className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 transition"
          >
            📦 Install Python & TypeScript SDKs
          </Link>
          <Link
            href="/attestations"
            className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 transition"
          >
            📜 Verify Onchain EAS Attestations
          </Link>
          <Link
            href="/liquidity"
            className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 transition"
          >
            💧 Aerodrome Liquidity Rebalancer
          </Link>
        </div>
      </div>
    </div>
  );
}
