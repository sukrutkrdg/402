"use client";

import { useState } from "react";
import type { ServiceMeta } from "./Marketplace";

interface AgentPersona {
  id: string;
  name: string;
  role: string;
  address: string;
  icon: string;
}

const AGENT_PERSONAS: AgentPersona[] = [
  {
    id: "sentinel",
    name: "Clanker Sentinel Bot",
    role: "Autonomous Honeypot & Rugpull Detection",
    address: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
    icon: "🛡️",
  },
  {
    id: "sniper",
    name: "Aerodrome Sniper Bot",
    role: "Sub-Second DEX Arbitrage & Memecoin Swapper",
    address: "0x1142F83d2524316F712b7D07b8b78F8bA42c99bc",
    icon: "⚡",
  },
  {
    id: "balancer",
    name: "DeFi Portfolio Balancer",
    role: "Morpho Health & Yield Optimizer",
    address: "0x973A31858f4D2125f48C880542DA11a2796f12D6",
    icon: "📊",
  },
];

interface SimulationResult {
  simulationId: string;
  timestamp: string;
  serviceId: string;
  eip712: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: string;
    };
    primaryType: string;
    message: {
      from: string;
      to: string;
      value: string;
      validAfter: number;
      validBefore: number;
      nonce: string;
    };
    typedDataHash: string;
    signature: {
      v: number;
      r: string;
      s: string;
      compactHex: string;
    };
  };
  settlement: {
    network: string;
    chainId: number;
    settlerContract: string;
    txHash: string;
    blockNumber: number;
    gasUsedGwei: number;
    gasSponsoredByFacilitator: boolean;
    builderCode: string;
    totalAmountUsdc: number;
    publisherPayoutUsdc: number;
    platformFeeUsdc: number;
    latencyMs: number;
    explorerUrl: string;
  };
  buyerAgent: {
    address: string;
    role: string;
    spentUsdc: number;
    remainingMockBalanceUsdc: number;
  };
}

export default function MultiAgentSandbox({ services }: { services: ServiceMeta[] }) {
  const [selectedPersona, setSelectedPersona] = useState<AgentPersona>(AGENT_PERSONAS[0]);
  const [balance, setBalance] = useState<number>(10.0);
  const [selectedServiceId, setSelectedServiceId] = useState<string>("clanker-token-audit");
  const [amountUsdc, setAmountUsdc] = useState<number>(0.05);
  const [simulating, setSimulating] = useState(false);
  const [latestReceipt, setLatestReceipt] = useState<SimulationResult | null>(null);
  const [history, setHistory] = useState<SimulationResult[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const selectedService = services.find((s) => s.id === selectedServiceId) || services[0];

  const handleRunSimulation = async () => {
    if (simulating || balance <= 0) return;
    setSimulating(true);

    try {
      const res = await fetch("/api/simulate/eip3009", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serviceId: selectedServiceId,
          amountUsdc,
          buyerAddress: selectedPersona.address,
          agentRole: selectedPersona.role,
          startingBalance: balance,
        }),
      });

      const json = await res.json();
      if (json.success) {
        setLatestReceipt(json);
        setBalance(json.buyerAgent.remainingMockBalanceUsdc);
        setHistory((prev) => [json, ...prev.slice(0, 9)]);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSimulating(false);
    }
  };

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Simulation Info Card */}
      <div className="rounded-xl bg-gradient-to-r from-blue-950/40 via-indigo-950/30 to-purple-950/20 border border-blue-500/20 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_10px_#34d399]" />
              <h2 className="text-lg font-bold text-white tracking-tight">
                Multi-Agent EIP-3009 Micropayment Sandbox
              </h2>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30">
                Base Mainnet (8453)
              </span>
            </div>
            <p className="text-xs text-gray-400 max-w-2xl">
              Simulate autonomous AI agents transacting with zero gas fees. Generates genuine EIP-712 typed signatures, validates TransferWithAuthorization digests, and executes instantaneous facilitator settlements with 90% publisher revenue distribution.
            </p>
          </div>

          {/* Virtual Balance Display */}
          <div className="flex items-center gap-3 bg-black/40 border border-white/10 rounded-xl px-4 py-2.5">
            <div>
              <span className="text-[10px] uppercase tracking-wider text-gray-400 block font-semibold">
                Simulated Agent USDC Balance
              </span>
              <span className="font-mono text-xl font-black text-emerald-400">
                ${balance.toFixed(2)} <span className="text-xs text-gray-400">mock USDC</span>
              </span>
            </div>
            <button
              onClick={() => setBalance((prev) => Number((prev + 10.0).toFixed(2)))}
              className="text-xs px-2.5 py-1.5 rounded-lg font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 transition cursor-pointer"
            >
              + Refill $10
            </button>
          </div>
        </div>
      </div>

      {/* Grid: Agent Persona & Config (Left) | Execution & Receipt (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Persona & Config */}
        <div className="lg:col-span-5 space-y-4">
          {/* Persona Picker */}
          <div className="rounded-xl bg-[#0d111a] border border-white/10 p-4 space-y-3">
            <label className="text-xs font-semibold text-gray-300 uppercase tracking-wider block">
              1. Select Buyer Agent Persona
            </label>
            <div className="space-y-2">
              {AGENT_PERSONAS.map((persona) => {
                const isSelected = selectedPersona.id === persona.id;
                return (
                  <button
                    key={persona.id}
                    onClick={() => setSelectedPersona(persona)}
                    className={`w-full text-left p-3 rounded-lg border transition cursor-pointer flex items-start gap-3 ${
                      isSelected
                        ? "bg-blue-600/15 border-blue-500/50 text-white"
                        : "bg-white/[0.02] border-white/5 text-gray-400 hover:bg-white/[0.05]"
                    }`}
                  >
                    <span className="text-2xl p-1 bg-black/30 rounded-lg">{persona.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <strong className="text-xs text-white">{persona.name}</strong>
                        {isSelected && (
                          <span className="text-[10px] text-blue-400 font-mono font-bold">ACTIVE</span>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-400 mt-0.5">{persona.role}</p>
                      <code className="text-[10px] text-gray-500 block font-mono mt-1 truncate">
                        {persona.address}
                      </code>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Target Service & Amount */}
          <div className="rounded-xl bg-[#0d111a] border border-white/10 p-4 space-y-3">
            <label className="text-xs font-semibold text-gray-300 uppercase tracking-wider block">
              2. Target Microservice & Amount
            </label>
            <div>
              <span className="text-[11px] text-gray-400 block mb-1">Target Service</span>
              <select
                value={selectedServiceId}
                onChange={(e) => setSelectedServiceId(e.target.value)}
                className="w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500"
              >
                {services.map((svc) => (
                  <option key={svc.id} value={svc.id} className="bg-[#0b0e14] text-white">
                    {svc.icon} {svc.name} — {svc.price}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <div>
                <span className="text-[11px] text-gray-400 block mb-1">Micro-Payment (USDC)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="1.00"
                  value={amountUsdc}
                  onChange={(e) => setAmountUsdc(Number(e.target.value))}
                  className="w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-xs font-mono text-emerald-400 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <span className="text-[11px] text-gray-400 block mb-1">Publisher Share (90%)</span>
                <div className="w-full rounded-lg bg-black/20 border border-white/5 px-3 py-2 text-xs font-mono text-gray-400">
                  ${(amountUsdc * 0.9).toFixed(4)}
                </div>
              </div>
            </div>

            {/* Execute Button */}
            <button
              onClick={handleRunSimulation}
              disabled={simulating || balance < amountUsdc}
              className={`w-full py-3 rounded-lg font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-lg ${
                simulating || balance < amountUsdc
                  ? "bg-gray-800 text-gray-500 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-500 text-white shadow-blue-500/20"
              }`}
            >
              {simulating ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Computing EIP-712 & Settling on Base...</span>
                </>
              ) : balance < amountUsdc ? (
                <span>⚠️ Insufficient Mock USDC (Refill Above)</span>
              ) : (
                <>
                  <span>⚡ Broadcast Simulated EIP-3009 Transfer (${amountUsdc.toFixed(2)} USDC)</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Right Column: Cryptographic Receipt Visualizer */}
        <div className="lg:col-span-7 space-y-4">
          {latestReceipt ? (
            <div className="rounded-xl bg-[#080b12] border border-blue-500/30 overflow-hidden shadow-xl">
              {/* Receipt Header */}
              <div className="p-4 bg-gradient-to-r from-blue-900/30 via-indigo-900/20 to-transparent border-b border-white/10 flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                  <strong className="text-xs text-white font-mono uppercase tracking-wide">
                    EIP-3009 Settlement Receipt
                  </strong>
                  <span className="text-[10px] font-mono text-gray-400">
                    ({latestReceipt.simulationId})
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-emerald-400 font-bold">
                    Latency: {latestReceipt.settlement.latencyMs}ms
                  </span>
                  <a
                    href={latestReceipt.settlement.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-blue-400 hover:text-blue-300 underline font-mono"
                  >
                    View on Basescan ↗
                  </a>
                  <a
                    href={`https://warpcast.com/~/compose?text=${encodeURIComponent(
                      `Just simulated an autonomous EIP-3009 micro-payment on Base via x402 Bazaar!\n\n🤖 Agent: ${latestReceipt.buyerAgent.role}\n⚡ Service: ${latestReceipt.serviceId}\n💰 Settled: $${latestReceipt.settlement.totalAmountUsdc} USDC (0 Gas)\n🏛️ Builder Code: bc_pa0gqlv1`
                    )}&embeds[]=${encodeURIComponent(
                      `https://402.com.tr/api/frames/share?service=${latestReceipt.serviceId}&title=${encodeURIComponent(
                        `Agent Micropayment: ${latestReceipt.serviceId}`
                      )}&subtitle=${encodeURIComponent(
                        `Settled $${latestReceipt.settlement.totalAmountUsdc} USDC on Base`
                      )}`
                    )}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] px-2.5 py-1 rounded bg-[#7c65c1]/20 hover:bg-[#7c65c1]/30 text-[#a78bfa] border border-[#7c65c1]/30 font-semibold transition flex items-center gap-1.5"
                  >
                    <span>🟣 Cast to Warpcast</span>
                  </a>
                </div>
              </div>

              {/* Receipt Content */}
              <div className="p-4 space-y-4 text-xs font-mono">
                {/* Step 1: EIP-712 Digest & Signature */}
                <div className="space-y-1.5 bg-black/40 border border-white/5 rounded-lg p-3">
                  <div className="flex items-center justify-between text-gray-400">
                    <span className="text-blue-400 font-bold">Step 1: EIP-712 TransferWithAuthorization</span>
                    <button
                      onClick={() => handleCopy(latestReceipt.eip712.typedDataHash, "digest")}
                      className="text-[10px] text-gray-500 hover:text-white"
                    >
                      {copiedKey === "digest" ? "✓ Copied" : "Copy Digest"}
                    </button>
                  </div>
                  <div className="text-[11px] text-gray-300 grid grid-cols-2 gap-2 pt-1">
                    <div>
                      <span className="text-gray-500 block">Domain:</span>
                      <span>{latestReceipt.eip712.domain.name} (v{latestReceipt.eip712.domain.version}) Chain #{latestReceipt.eip712.domain.chainId}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 block">Nonce:</span>
                      <span className="truncate block">{latestReceipt.eip712.message.nonce}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 block">Payer (From):</span>
                      <span className="truncate block text-sky-300">{latestReceipt.eip712.message.from}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 block">Settler (To):</span>
                      <span className="truncate block text-sky-300">{latestReceipt.eip712.message.to}</span>
                    </div>
                  </div>
                  <div className="pt-2 text-[10px] text-gray-500 border-t border-white/5 truncate">
                    Signature: v={latestReceipt.eip712.signature.v} | compact: {latestReceipt.eip712.signature.compactHex}
                  </div>
                </div>

                {/* Step 2: Onchain Settlement & Revenue Split */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-black/40 border border-white/5 rounded-lg p-3 text-center">
                    <span className="text-[10px] text-gray-400 block uppercase">Total Settled</span>
                    <strong className="text-sm text-white block mt-0.5">
                      ${latestReceipt.settlement.totalAmountUsdc.toFixed(2)}
                    </strong>
                    <span className="text-[10px] text-emerald-400 block mt-0.5">Gas Sponsored: 100%</span>
                  </div>
                  <div className="bg-black/40 border border-emerald-500/20 rounded-lg p-3 text-center">
                    <span className="text-[10px] text-emerald-400 block uppercase font-bold">Publisher Share (90%)</span>
                    <strong className="text-sm text-emerald-300 block mt-0.5">
                      ${latestReceipt.settlement.publisherPayoutUsdc.toFixed(4)}
                    </strong>
                    <span className="text-[10px] text-gray-500 block mt-0.5">Direct Payout</span>
                  </div>
                  <div className="bg-black/40 border border-white/5 rounded-lg p-3 text-center">
                    <span className="text-[10px] text-gray-400 block uppercase">Protocol Fee (10%)</span>
                    <strong className="text-sm text-gray-300 block mt-0.5">
                      ${latestReceipt.settlement.platformFeeUsdc.toFixed(4)}
                    </strong>
                    <span className="text-[10px] text-blue-400 block mt-0.5">Facilitator Treasury</span>
                  </div>
                </div>

                {/* Step 3: Base Builder Code & Block Verification */}
                <div className="bg-black/40 border border-white/5 rounded-lg p-3 text-gray-400 space-y-1">
                  <div className="flex items-center justify-between">
                    <span>Base Block #{latestReceipt.settlement.blockNumber}</span>
                    <span className="text-blue-400">Builder Code: {latestReceipt.settlement.builderCode}</span>
                  </div>
                  <div className="text-[10px] text-gray-500 truncate">
                    Tx: {latestReceipt.settlement.txHash}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-[#080b12] border border-white/10 p-12 text-center text-gray-500 flex flex-col items-center justify-center min-h-[360px]">
              <span className="text-4xl block mb-3">🤖</span>
              <strong className="text-sm text-white block mb-1">
                No Simulated Micropayment Executed Yet
              </strong>
              <p className="text-xs max-w-md text-gray-400">
                Choose an agent persona on the left, select a microservice, and click &quot;Broadcast Simulated EIP-3009 Transfer&quot; to inspect full cryptographic authorization receipts and zero-gas Base settlement metrics.
              </p>
            </div>
          )}

          {/* Session History Table */}
          {history.length > 0 && (
            <div className="rounded-xl bg-[#0d111a] border border-white/10 p-4 space-y-2">
              <h3 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
                Session Simulation History ({history.length})
              </h3>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {history.map((item, idx) => (
                  <div
                    key={item.simulationId || idx}
                    className="flex items-center justify-between px-3 py-1.5 rounded bg-black/40 border border-white/5 text-[11px] font-mono"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-blue-400">{item.serviceId}</span>
                      <span className="text-gray-500">|</span>
                      <span className="text-gray-400">{item.buyerAgent.role.split(" ")[0]}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-emerald-400 font-bold">${item.settlement.totalAmountUsdc.toFixed(2)}</span>
                      <span className="text-gray-500">{item.settlement.latencyMs}ms</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
