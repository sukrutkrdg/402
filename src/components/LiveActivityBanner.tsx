"use client";

import { useState, useEffect } from "react";

const RECENT_SETTLEMENTS = [
  { service: "deep-dd", price: "$0.75", ms: 17920, note: "18-Key AI Evaluation" },
  { service: "polymarket-odds", price: "$0.02", ms: 412, note: "Fed FOMC Probabilities" },
  { service: "agent-provenance", price: "$0.03", ms: 290, note: "Virtuals & EIP-7702 Verify" },
  { service: "morpho-health", price: "$0.04", ms: 480, note: "cbBTC/USDC Health Factor" },
  { service: "gas-oracle", price: "$0.01", ms: 140, note: "Block 52.4M Fee Estimate" },
  { service: "wash-trading", price: "$0.03", ms: 610, note: "22K Transfers Analyzed" },
  { service: "rwa-yield-benchmark", price: "$0.02", ms: 380, note: "Treasury vs DeFi Spread" },
  { service: "safe-to-send", price: "$0.01", ms: 320, note: "KYC & Sanctions Verified" },
];

export default function LiveActivityBanner({ onOpenModal }: { onOpenModal?: () => void }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % RECENT_SETTLEMENTS.length);
    }, 3500);
    return () => clearInterval(timer);
  }, []);

  const active = RECENT_SETTLEMENTS[index];

  return (
    <div className="border-b border-white/5 bg-[#090b10]/80 backdrop-blur-md px-4 py-2 text-xs">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 flex-wrap">
        {/* Left: Live status indicator */}
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
          </span>
          <span className="font-semibold text-gray-200">Base Mainnet Live</span>
          <span className="text-gray-500 hidden sm:inline">·</span>
          <span className="text-emerald-400 font-mono hidden sm:inline">213+ Verified Settlements</span>
          <span className="text-gray-500 hidden md:inline">·</span>
          <span className="text-gray-400 hidden md:inline">
            Builder Code: <code className="text-sky-300 font-mono">bc_pa0gqlv1</code>
          </span>
        </div>

        {/* Center: Live ticker rotation */}
        <div className="flex items-center gap-2 text-gray-300 bg-white/[0.03] px-2.5 py-1 rounded-full border border-white/5">
          <span className="text-gray-500 text-[11px] uppercase tracking-wider font-semibold">Latest Call:</span>
          <span className="font-mono text-sky-400 font-medium">{active.service}</span>
          <span className="text-emerald-300 font-mono font-semibold">{active.price}</span>
          <span className="text-gray-500 text-[11px] hidden lg:inline">({active.note})</span>
        </div>

        {/* Right: Connect Agent button */}
        {onOpenModal && (
          <button
            onClick={onOpenModal}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-base-blue/20 hover:bg-base-blue/30 text-sky-300 hover:text-sky-200 border border-base-blue/30 font-medium transition cursor-pointer"
          >
            <span>⚡ Connect AI Agent</span>
          </button>
        )}
      </div>
    </div>
  );
}
