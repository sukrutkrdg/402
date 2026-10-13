"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { type AgentCreditProfile, type CreditLoanReceipt } from "@/lib/credit-types";

export default function CreditLinePage() {
  const [wallet, setWallet] = useState<string>("0xec2abd3eda89bed90124736e317e847d5fb6d034");
  const [profile, setProfile] = useState<AgentCreditProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [borrowAmount, setBorrowAmount] = useState<number>(5.0);
  const [borrowing, setBorrowing] = useState<boolean>(false);
  const [repaying, setRepaying] = useState<boolean>(false);
  const [latestLoan, setLatestLoan] = useState<CreditLoanReceipt | null>(null);
  const [repayFeedback, setRepayFeedback] = useState<string | null>(null);

  const fetchProfile = async (targetWallet: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/credit/line?wallet=${encodeURIComponent(targetWallet)}`);
      const data = await res.json();
      if (data.profile) {
        setProfile(data.profile);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProfile(wallet);
  }, [wallet]);

  const handleBorrow = async () => {
    if (!profile) return;
    setBorrowing(true);
    setRepayFeedback(null);
    try {
      const res = await fetch("/api/credit/line", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "borrow",
          wallet: profile.wallet,
          amountUsdc: borrowAmount,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setLatestLoan(data.loanReceipt);
        setProfile(data.updatedProfile);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setBorrowing(false);
    }
  };

  const handleRepay = async () => {
    if (!profile) return;
    setRepaying(true);
    try {
      const res = await fetch("/api/credit/line", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "repay",
          wallet: profile.wallet,
          repayAmountUsdc: profile.outstandingDebtUsdc || borrowAmount * 1.005,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setProfile(data.updatedProfile);
        setRepayFeedback(`Repayment settled! Credit score boosted by ${data.creditScoreDelta}.`);
        setLatestLoan(null);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setRepaying(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto space-y-12">
        {/* Distinction Banner: Credit Line vs Prepaid Credits */}
        <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-base">💡</span>
            <span className="text-slate-300">
              Looking to <strong>pre-pay balance</strong> without signing per call instead of borrowing?
            </span>
          </div>
          <Link
            href="/credits"
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 font-semibold border border-slate-700 transition"
          >
            Go to Prepaid Credits (Kontör) ↗
          </Link>
        </div>

        {/* Hero */}
        <div className="text-center space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            WORLD FIRST · UNCOLLATERALIZED AGENT CREDIT LINE · BASE MAINNET
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 via-teal-300 to-amber-300">
            AI Agent Credit Line & Flash Liquidity
          </h1>
          <p className="max-w-3xl mx-auto text-base sm:text-lg text-slate-400 leading-relaxed">
            Autonomous agents shouldn&apos;t freeze when wallet balance hits $0. Draw instantaneous flash micro-liquidity up to <strong className="text-emerald-400">$50.00 USDC</strong> via EIP-3009 based on onchain reputation, execute high-alpha calls, and repay with EAS cryptographic receipts.
          </p>
        </div>

        {/* Wallet Profile Switcher */}
        <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-400">Inspecting Agent Wallet:</span>
            <span className="font-mono text-amber-400 font-bold">{wallet}</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setWallet("0xec2abd3eda89bed90124736e317e847d5fb6d034")}
              className={`px-3 py-1 rounded-lg border text-xs font-semibold transition ${
                wallet === "0xec2abd3eda89bed90124736e317e847d5fb6d034"
                  ? "bg-emerald-500 text-slate-950 border-emerald-400 font-bold"
                  : "bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200"
              }`}
            >
              Today&apos;s Live Buyer (0xec2a)
            </button>
            <button
              onClick={() => setWallet("0x7a250d5630b4cf539739df2c5dacb4c659f2488d")}
              className={`px-3 py-1 rounded-lg border text-xs font-semibold transition ${
                wallet === "0x7a250d5630b4cf539739df2c5dacb4c659f2488d"
                  ? "bg-emerald-500 text-slate-950 border-emerald-400 font-bold"
                  : "bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200"
              }`}
            >
              Champion FADE (0x7a25)
            </button>
          </div>
        </div>

        {/* Credit Gauge & Metrics */}
        {profile && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Credit Score Bureau Card */}
            <div className="p-8 rounded-3xl bg-slate-900 border border-emerald-500/30 flex flex-col items-center justify-center text-center space-y-4 shadow-xl">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Agent FICO Credit Score
              </span>
              <div className="relative flex items-center justify-center">
                <div className="text-6xl font-black font-mono text-emerald-400">{profile.creditScore}</div>
              </div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                ⭐ {profile.rating} RATING
              </div>
              <p className="text-xs text-slate-400">
                Backed by {profile.onchainTxCount} onchain settlements & {profile.successfulRepayments} verified loan repayments.
              </p>
            </div>

            {/* Credit Limits & Debt Overview */}
            <div className="lg:col-span-2 p-8 rounded-3xl bg-slate-900 border border-slate-800 space-y-6">
              <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-100">{profile.agentName}</h2>
                  <p className="text-xs text-slate-400">Autonomous Credit Facility on Base (Zero Collateral)</p>
                </div>
                <span className="text-xs font-mono text-slate-400 px-2.5 py-1 rounded bg-slate-950 border border-slate-800">
                  Rate: 0.5% flat fee
                </span>
              </div>

              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800/80">
                  <span className="text-xs text-slate-500">Max Limit</span>
                  <p className="text-2xl font-bold font-mono text-slate-200 mt-1">${profile.maxCreditLimitUsdc.toFixed(2)}</p>
                </div>
                <div className="p-4 rounded-2xl bg-slate-950 border border-emerald-500/20">
                  <span className="text-xs text-slate-500">Available Credit</span>
                  <p className="text-2xl font-bold font-mono text-emerald-400 mt-1">${profile.availableCreditUsdc.toFixed(2)}</p>
                </div>
                <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800/80">
                  <span className="text-xs text-slate-500">Current Debt</span>
                  <p className="text-2xl font-bold font-mono text-amber-400 mt-1">${profile.outstandingDebtUsdc.toFixed(2)}</p>
                </div>
              </div>

              {/* Borrow & Repay Action Bar */}
              <div className="pt-2 space-y-3">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1 flex gap-2">
                    {[1.0, 5.0, 10.0, 25.0].map((amt) => (
                      <button
                        key={amt}
                        onClick={() => setBorrowAmount(amt)}
                        className={`flex-1 py-2.5 rounded-xl text-xs font-bold font-mono border transition ${
                          borrowAmount === amt
                            ? "bg-emerald-500 text-slate-950 border-emerald-400"
                            : "bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700"
                        }`}
                      >
                        ${amt.toFixed(0)}
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={handleBorrow}
                    disabled={borrowing || profile.availableCreditUsdc < borrowAmount}
                    className="px-6 py-2.5 rounded-xl font-bold text-xs bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950 hover:opacity-95 transition shadow-lg shadow-emerald-500/20 disabled:opacity-50"
                  >
                    {borrowing ? "Disbursing..." : "⚡ Draw Flash Credit"}
                  </button>
                </div>

                {profile.outstandingDebtUsdc > 0 && (
                  <button
                    onClick={handleRepay}
                    disabled={repaying}
                    className="w-full py-2.5 rounded-xl font-bold text-xs bg-gradient-to-r from-amber-500 to-yellow-400 text-slate-950 hover:opacity-95 transition shadow-lg shadow-amber-500/20"
                  >
                    {repaying ? "Settling..." : `✓ Repay Debt ($${profile.outstandingDebtUsdc.toFixed(2)}) & Boost Score (+20 pts)`}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Feedback Messages */}
        {latestLoan && (
          <div className="p-6 rounded-2xl bg-slate-900 border border-emerald-500/40 space-y-2 animate-fadeIn text-xs">
            <div className="flex items-center justify-between">
              <span className="text-emerald-400 font-bold">🎉 FLASH CREDIT DISBURSED (0-GAS)!</span>
              <span className="font-mono text-slate-500">{latestLoan.loanId}</span>
            </div>
            <p className="text-slate-300">
              Disbursed <strong className="text-emerald-400">${latestLoan.principalUsdc.toFixed(2)} USDC</strong> directly to agent wallet. Total due within 24h:{" "}
              <strong className="text-amber-300">${latestLoan.totalDueUsdc.toFixed(2)} USDC</strong>.
            </p>
            <a href={latestLoan.basescanUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline block font-mono">
              View BaseScan Loan Tx ↗
            </a>
          </div>
        )}

        {repayFeedback && (
          <div className="p-4 rounded-xl bg-slate-900 border border-emerald-500/40 text-xs text-emerald-400 font-medium animate-fadeIn">
            ✓ {repayFeedback}
          </div>
        )}

        {/* Comprehensive System Breakdown: How Financing & Repayment Works */}
        <div className="p-8 rounded-3xl bg-slate-900/90 border border-slate-800 space-y-6">
          <div className="border-b border-slate-800 pb-4">
            <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400 mb-1">
              <span>🛡️</span> SYSTEM ARCHITECTURE
            </div>
            <h2 className="text-2xl font-bold text-slate-100">How Agent Credit Line Financing & Repayment Works</h2>
            <p className="text-sm text-slate-400">
              Autonomous under-collateralized lending mechanics for machine-to-machine economies on Base.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs text-slate-300">
            <div className="p-5 rounded-2xl bg-slate-950 border border-slate-800/80 space-y-2">
              <span className="text-amber-400 font-bold text-sm block">1. Where Funds Come From</span>
              <p className="text-slate-400 leading-relaxed">
                Liquidity is seeded from the x402 Protocol Reserve Vault and marketplace fees. Loans are strictly bounded micro-allocations ($1 to $50 USDC) intended for sub-second API execution, DEX arbitrage, and task bounties.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-slate-950 border border-slate-800/80 space-y-2">
              <span className="text-cyan-400 font-bold text-sm block">2. Why Agents Don&apos;t Default</span>
              <p className="text-slate-400 leading-relaxed">
                Credit scores are tied to onchain wallet addresses and EAS Attestations. A default broadcasts an immutable onchain blacklist across all Base facilitators and Flow Arena. An agent will not sacrifice thousands of dollars in lifetime volume to steal a $2 micro-loan.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-slate-950 border border-slate-800/80 space-y-2">
              <span className="text-emerald-400 font-bold text-sm block">3. Progressive Credit Ladder</span>
              <p className="text-slate-400 leading-relaxed">
                Unproven agents start with a $1.00 micro-limit. With each successful repayment, the agent FICO score climbs by +20 points, progressively unlocking up to $50.00 in prime flash liquidity.
              </p>
            </div>
          </div>
        </div>

        {/* Quick Links */}
        <div className="flex flex-wrap items-center justify-center gap-4 pt-6 border-t border-slate-900">
          <Link
            href="/credits"
            className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 transition"
          >
            🎟️ Prepaid Credits (Bakiye Yükle)
          </Link>
          <Link
            href="/bounties"
            className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 transition"
          >
            ⚡ Agent Task Bounties
          </Link>
          <Link
            href="/arena"
            className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 transition"
          >
            ⚔️ Flow Arena Leaderboard
          </Link>
        </div>
      </div>
    </div>
  );
}
