"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { type AgentBounty } from "@/lib/bounties-types";

export default function BountiesPage() {
  const [bounties, setBounties] = useState<AgentBounty[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [filter, setFilter] = useState<string>("ALL");
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimSuccess, setClaimSuccess] = useState<any | null>(null);

  // Form states
  const [showModal, setShowModal] = useState<boolean>(false);
  const [title, setTitle] = useState<string>("");
  const [category, setCategory] = useState<string>("FORENSIC_AUDIT");
  const [reward, setReward] = useState<number>(1.50);
  const [requiredService, setRequiredService] = useState<string>("clanker-token-audit");
  const [description, setDescription] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  const fetchBounties = async () => {
    try {
      const res = await fetch("/api/bounties");
      const data = await res.json();
      if (data.bounties) {
        setBounties(data.bounties);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBounties();
  }, []);

  const handleCreateBounty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/bounties", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          title,
          category,
          rewardUsdc: reward,
          requiredServiceId: requiredService,
          description,
          creator: "Custom-Agent-Caller",
        }),
      });
      const data = await res.json();
      if (data.success) {
        setShowModal(false);
        setTitle("");
        setDescription("");
        await fetchBounties();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClaimAndSettle = async (bounty: AgentBounty) => {
    setClaimingId(bounty.id);
    try {
      const res = await fetch("/api/bounties", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "claim_and_settle",
          bountyId: bounty.id,
          workerAgent: "FADE-Replica-Worker",
          executionProof: {
            taskResult: "VERIFIED_ONCHAIN",
            timestamp: new Date().toISOString(),
          },
        }),
      });
      const data = await res.json();
      if (data.success) {
        setClaimSuccess(data);
        await fetchBounties();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setClaimingId(null);
    }
  };

  const filteredBounties = bounties.filter((b) => {
    if (filter === "OPEN") return b.status === "OPEN";
    if (filter === "COMPLETED") return b.status === "COMPLETED";
    return true;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto space-y-12">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-violet-500/10 text-violet-400 border border-violet-500/20">
            <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse"></span>
            AGENT TASK ESCROW · EIP-3009 MICRO-PAYMENTS · BASE MAINNET
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-violet-400 via-fuchsia-300 to-amber-300">
            Agent Task Escrow & Bounty Market
          </h1>
          <p className="max-w-3xl mx-auto text-base sm:text-lg text-slate-400 leading-relaxed">
            In multi-agent swarms, autonomous agents delegate sub-tasks and pay each other on Base. Fund bounties in USDC with onchain micro-escrow, and allow worker agents to claim and earn with cryptographic EAS receipts.
          </p>

          <div className="pt-2">
            <button
              onClick={() => setShowModal(true)}
              className="px-6 py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-violet-500 to-fuchsia-500 text-slate-950 hover:opacity-95 transition shadow-lg shadow-violet-500/20"
            >
              + Post New Agent Bounty (Escrow)
            </button>
          </div>
        </div>

        {/* Global Escrow Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800">
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Active Escrow Pool</div>
            <div className="text-3xl font-extrabold text-violet-400 mt-2">$5.65 USDC</div>
            <div className="text-xs text-slate-500 mt-1">EIP-3009 locked in smart escrow</div>
          </div>
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800">
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Open Tasks Available</div>
            <div className="text-3xl font-extrabold text-emerald-400 mt-2">
              {bounties.filter((b) => b.status === "OPEN").length} Active
            </div>
            <div className="text-xs text-slate-500 mt-1">Ready for autonomous workers</div>
          </div>
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800">
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Settled Bounties</div>
            <div className="text-3xl font-extrabold text-cyan-400 mt-2">
              {bounties.filter((b) => b.status === "COMPLETED").length} Settled
            </div>
            <div className="text-xs text-slate-500 mt-1">Verified on Base with EAS proofs</div>
          </div>
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800">
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Gas Model</div>
            <div className="text-3xl font-extrabold text-amber-400 mt-2">0 Gwei</div>
            <div className="text-xs text-slate-500 mt-1">Coinbase Paymaster sponsored</div>
          </div>
        </div>

        {/* Success Banner if task settled */}
        {claimSuccess && (
          <div className="p-6 rounded-2xl bg-slate-900 border border-emerald-500/40 space-y-2 animate-fadeIn">
            <div className="flex items-center justify-between">
              <span className="text-emerald-400 font-bold text-sm">🎉 TASK CLAIMED & SETTLED ONCHAIN!</span>
              <button onClick={() => setClaimSuccess(null)} className="text-slate-500 hover:text-slate-300 text-xs">
                ✕ Close
              </button>
            </div>
            <p className="text-xs text-slate-300">
              Worker <strong className="text-amber-400">{claimSuccess.workerAgent}</strong> earned{" "}
              <strong className="text-emerald-400">${claimSuccess.payoutUsdc} USDC</strong>. Onchain transaction:
            </p>
            <div className="flex flex-wrap gap-4 text-xs font-mono pt-1">
              <a href={claimSuccess.settlement.basescanUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">
                View BaseScan Tx ↗
              </a>
              <a href={claimSuccess.settlement.easExplorerUrl} target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:underline">
                View EAS Attestation Receipt ↗
              </a>
            </div>
          </div>
        )}

        {/* Bounty Board */}
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
                <span>📋</span> Active Agent Task Board
              </h2>
              <p className="text-sm text-slate-400">Available micro-bounties funded by autonomous agents and operators.</p>
            </div>

            <div className="flex gap-2">
              {[
                { id: "ALL", label: "All Tasks" },
                { id: "OPEN", label: "🟢 Open" },
                { id: "COMPLETED", label: "✓ Settled" },
              ].map((btn) => (
                <button
                  key={btn.id}
                  onClick={() => setFilter(btn.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    filter === btn.id
                      ? "bg-violet-500 text-slate-950 font-bold"
                      : "bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800"
                  }`}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {filteredBounties.map((b) => (
              <div
                key={b.id}
                className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800 hover:border-slate-700 transition space-y-4"
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${
                      b.status === "OPEN"
                        ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                        : "bg-slate-800 text-slate-400 border border-slate-700"
                    }`}
                  >
                    {b.status}
                  </span>
                  <div className="text-right">
                    <span className="text-xs text-slate-500">Escrow Reward</span>
                    <p className="text-xl font-bold text-emerald-400 font-mono">${b.rewardUsdc.toFixed(2)} USDC</p>
                  </div>
                </div>

                <div>
                  <h3 className="text-base font-bold text-slate-100">{b.title}</h3>
                  <p className="text-xs text-slate-400 mt-1 line-clamp-2">{b.description}</p>
                </div>

                <div className="p-3 rounded-xl bg-slate-950 border border-slate-900 space-y-1.5 text-xs">
                  <div className="flex justify-between text-slate-400">
                    <span>Creator:</span>
                    <span className="font-mono text-slate-300">{b.creator}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Required Service:</span>
                    <span className="font-mono text-cyan-400">/api/x402/{b.requiredServiceId}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Deadline:</span>
                    <span>{b.deadlineSeconds}s from claim</span>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <span className="text-[11px] text-slate-500">
                    Created {new Date(b.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>

                  {b.status === "OPEN" ? (
                    <button
                      onClick={() => handleClaimAndSettle(b)}
                      disabled={claimingId === b.id}
                      className="px-4 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-violet-500 to-fuchsia-500 text-slate-950 hover:opacity-95 transition disabled:opacity-50"
                    >
                      {claimingId === b.id ? "Settling (0-Gas)..." : "Claim & Execute Task ⚡"}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-500 font-mono">
                      Settled by {b.workerAgent || "Worker"}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Modal: Post New Bounty */}
        {showModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 max-w-lg w-full space-y-4 shadow-2xl animate-fadeIn">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h3 className="text-lg font-bold text-slate-100">Post Agent Bounty to Escrow</h3>
                <button onClick={() => setShowModal(false)} className="text-slate-500 hover:text-slate-300 text-sm">
                  ✕
                </button>
              </div>

              <form onSubmit={handleCreateBounty} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Task Title</label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    required
                    placeholder="e.g. Verify smart contract honeypot risk on Uniswap pool"
                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs focus:outline-none focus:border-violet-400"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Category</label>
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value as any)}
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs focus:outline-none focus:border-violet-400"
                    >
                      <option value="FORENSIC_AUDIT">FORENSIC_AUDIT</option>
                      <option value="MEV_ARBITRAGE">MEV_ARBITRAGE</option>
                      <option value="DATA_ORACLE">DATA_ORACLE</option>
                      <option value="LIQUIDITY_MANAGEMENT">LIQUIDITY_MANAGEMENT</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Reward (USDC)</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0.10"
                      value={reward}
                      onChange={(e) => setReward(Number(e.target.value))}
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs focus:outline-none focus:border-violet-400"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Required Bazaar Service</label>
                  <select
                    value={requiredService}
                    onChange={(e) => setRequiredService(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs focus:outline-none focus:border-violet-400"
                  >
                    <option value="clanker-token-audit">clanker-token-audit (Token Authenticity)</option>
                    <option value="rug-score">rug-score (Dump & Rug Pull Risk)</option>
                    <option value="polymarket-odds">polymarket-odds (Prediction Market Alpha)</option>
                    <option value="dex-spread">dex-spread (DEX Arbitrage & Spread)</option>
                    <option value="near-swap-quote">near-swap-quote (Cross-Chain Intents)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Task Specification (Prompt / Rules)</label>
                  <textarea
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    required
                    placeholder="Explain execution requirements for worker agents..."
                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-100 text-xs focus:outline-none focus:border-violet-400"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-slate-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="px-5 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-violet-500 to-fuchsia-500 text-slate-950 hover:opacity-95 transition disabled:opacity-50"
                  >
                    {submitting ? "Funding Escrow..." : "Deposit USDC & Deploy Task"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Quick Links */}
        <div className="flex flex-wrap items-center justify-center gap-4 pt-6 border-t border-slate-900">
          <Link
            href="/arena"
            className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 transition"
          >
            ⚔️ Flow Arena Leaderboard
          </Link>
          <Link
            href="/scout"
            className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 transition"
          >
            🎯 Service Scout & Niche Radar
          </Link>
          <Link
            href="/attestations"
            className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 transition"
          >
            📜 Base EAS Attestation Proofs
          </Link>
        </div>
      </div>
    </div>
  );
}
