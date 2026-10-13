"use client";

import { useState } from "react";
import Link from "next/link";
import { AERODROME_CL_POOLS, type AerodromeCLPool } from "@/app/api/liquidity/rebalance/route";

interface RebalancePlan {
  poolId: string;
  pair: string;
  dex: string;
  builderCode: string;
  currentPrice: number;
  currentTick: number;
  rebalanceRecommendation: {
    action: string;
    targetRangePct: string;
    lowerPrice: number;
    upperPrice: number;
    optimalTickLower: number;
    optimalTickUpper: number;
    projectedConcentratedApy: number;
    capitalAllocatedUsdc: number;
    rebalanceExecutionFeeUsdc: number;
  };
  executionPlan: {
    settlementProtocol: string;
    gasSponsorship: string;
    simulatedTxHash: string;
    explorerUrl: string;
    status: string;
  };
}

export default function LiquidityPage() {
  const [selectedPool, setSelectedPool] = useState<AerodromeCLPool>(AERODROME_CL_POOLS[1]);
  const [capitalUsdc, setCapitalUsdc] = useState<number>(1000);
  const [rangePct, setRangePct] = useState<number>(5);
  const [loading, setLoading] = useState<boolean>(false);
  const [plan, setPlan] = useState<RebalancePlan | null>(null);

  const handleComputeRebalance = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/liquidity/rebalance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          poolId: selectedPool.id,
          capitalUsdc,
          rangeTolerancePct: rangePct,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setPlan(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "1.5rem 1rem 4rem" }}>
      {/* Top Banner */}
      <div style={{ marginBottom: "2rem" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", padding: "0.25rem 0.75rem", borderRadius: 999, backgroundColor: "rgba(0, 82, 255, 0.12)", border: "1px solid rgba(0, 82, 255, 0.25)", color: "#60a5fa", fontSize: "0.75rem", fontWeight: 700, marginBottom: "0.75rem" }}>
          <span>💧 AUTONOMOUS MARKET MAKER</span>
          <span>•</span>
          <code style={{ color: "#38bdf8" }}>Aerodrome CL on Base</code>
        </div>
        <h1 style={{ fontSize: "2rem", fontWeight: 900, letterSpacing: "-0.03em", color: "#f8fafc", margin: "0 0 0.5rem" }}>
          Concentrated Liquidity &amp; Aerodrome Pool Rebalancer
        </h1>
        <p style={{ color: "#94a3b8", fontSize: "0.95rem", maxWidth: 760, lineHeight: 1.6, margin: 0 }}>
          Autonomous DeFi agents continuously monitor Aerodrome Concentrated Liquidity (CL) pools on Base, recalculate optimal tick width bands, and execute zero-gas rebalancing via EIP-3009 transfer authorizations.
        </p>
      </div>

      {/* Pools Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
        {AERODROME_CL_POOLS.map((pool) => {
          const isSelected = selectedPool.id === pool.id;
          return (
            <div
              key={pool.id}
              onClick={() => {
                setSelectedPool(pool);
                setPlan(null);
              }}
              style={{
                backgroundColor: isSelected ? "#0a1329" : "#080c18",
                border: isSelected ? "1px solid #3b82f6" : "1px solid rgba(255,255,255,0.08)",
                borderRadius: 14,
                padding: "1.25rem",
                cursor: "pointer",
                transition: "all 0.2s ease",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.5rem" }}>
                <strong style={{ fontSize: "0.95rem", color: "#f8fafc" }}>{pool.pair}</strong>
                <span
                  style={{
                    fontSize: "0.68rem",
                    fontWeight: 700,
                    padding: "0.15rem 0.45rem",
                    borderRadius: 4,
                    backgroundColor:
                      pool.status === "OPTIMAL"
                        ? "rgba(16, 185, 129, 0.15)"
                        : pool.status === "DRIFTING"
                        ? "rgba(245, 158, 11, 0.15)"
                        : "rgba(239, 68, 68, 0.15)",
                    color:
                      pool.status === "OPTIMAL"
                        ? "#34d399"
                        : pool.status === "DRIFTING"
                        ? "#fbbf24"
                        : "#f87171",
                  }}
                >
                  {pool.status}
                </span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.75rem" }}>
                <span style={{ fontSize: "1.1rem", fontFamily: "monospace", fontWeight: 800, color: "#38bdf8" }}>
                  ${pool.currentPrice.toLocaleString()}
                </span>
                <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "#10b981" }}>
                  {pool.feeAprPct}% Fee APR
                </span>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#64748b" }}>
                <span>TVL: ${(pool.tvlUsdc / 1e6).toFixed(1)}M</span>
                <span>Vol 24h: {pool.volatility24hPct}%</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Rebalancer Interactive Form & Plan */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1.5rem", marginBottom: "2.5rem" }}>
        {/* Settings Box */}
        <div style={{ backgroundColor: "#080c18", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "1.5rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 800, color: "#f8fafc", margin: "0 0 1rem" }}>
            ⚙️ Position Parameters ({selectedPool.pair})
          </h2>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{ fontSize: "0.75rem", color: "#94a3b8", display: "block", marginBottom: "0.4rem" }}>
              Capital Allocation (USDC)
            </label>
            <input
              type="number"
              min="50"
              step="50"
              value={capitalUsdc}
              onChange={(e) => setCapitalUsdc(Number(e.target.value))}
              style={{ width: "100%", padding: "0.6rem 0.85rem", borderRadius: 8, backgroundColor: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.12)", color: "#f8fafc", fontFamily: "monospace", fontSize: "0.85rem", outline: "none" }}
            />
          </div>

          <div style={{ marginBottom: "1.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#94a3b8", marginBottom: "0.4rem" }}>
              <span>Target Concentration Band (±%)</span>
              <strong style={{ color: "#38bdf8" }}>±{rangePct}%</strong>
            </div>
            <input
              type="range"
              min="2"
              max="15"
              step="1"
              value={rangePct}
              onChange={(e) => setRangePct(Number(e.target.value))}
              style={{ width: "100%", accentColor: "#0052ff" }}
            />
          </div>

          <button
            onClick={handleComputeRebalance}
            disabled={loading}
            style={{ width: "100%", padding: "0.85rem", borderRadius: 10, backgroundColor: "#0052ff", color: "#ffffff", fontWeight: 700, fontSize: "0.85rem", border: "none", cursor: "pointer", transition: "background 0.2s" }}
          >
            {loading ? "Calculating Optimal Ticks on Base..." : `⚡ Calculate Rebalance Band (±${rangePct}%)`}
          </button>
        </div>

        {/* Execution Plan Box */}
        <div style={{ backgroundColor: "#080c18", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "1.5rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 800, color: "#f8fafc", margin: "0 0 1rem" }}>
            🧾 Autonomous Execution Plan
          </h2>

          {plan ? (
            <div style={{ fontSize: "0.82rem", fontFamily: "monospace", color: "#cbd5e1", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div style={{ padding: "0.75rem", borderRadius: 8, backgroundColor: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <span style={{ color: "#64748b", display: "block", fontSize: "0.72rem" }}>RECOMMENDED ACTION:</span>
                <strong style={{ color: plan.rebalanceRecommendation.action.includes("URGENT") ? "#f87171" : "#34d399", fontSize: "0.95rem" }}>
                  {plan.rebalanceRecommendation.action}
                </strong>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                <div style={{ padding: "0.5rem 0.75rem", borderRadius: 8, backgroundColor: "rgba(0,0,0,0.3)" }}>
                  <span style={{ color: "#64748b", display: "block", fontSize: "0.7rem" }}>LOWER TICK PRICE:</span>
                  <strong style={{ color: "#38bdf8" }}>${plan.rebalanceRecommendation.lowerPrice}</strong>
                </div>
                <div style={{ padding: "0.5rem 0.75rem", borderRadius: 8, backgroundColor: "rgba(0,0,0,0.3)" }}>
                  <span style={{ color: "#64748b", display: "block", fontSize: "0.7rem" }}>UPPER TICK PRICE:</span>
                  <strong style={{ color: "#38bdf8" }}>${plan.rebalanceRecommendation.upperPrice}</strong>
                </div>
              </div>

              <div style={{ padding: "0.75rem", borderRadius: 8, backgroundColor: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.2)" }}>
                <span style={{ color: "#10b981", display: "block", fontSize: "0.72rem" }}>BOOSTED CONCENTRATED APY:</span>
                <strong style={{ color: "#34d399", fontSize: "1.1rem" }}>
                  {plan.rebalanceRecommendation.projectedConcentratedApy}% APR
                </strong>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#64748b", paddingTop: "0.25rem" }}>
                <span>Gas: <strong style={{ color: "#10b981" }}>0 Gwei (Sponsored)</strong></span>
                <span>Builder: <code style={{ color: "#60a5fa" }}>bc_pa0gqlv1</code></span>
              </div>
            </div>
          ) : (
            <div style={{ minHeight: 180, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", color: "#64748b", fontSize: "0.85rem" }}>
              <div>
                <span style={{ fontSize: "1.75rem", display: "block", marginBottom: "0.5rem" }}>💧</span>
                <span>Select pool, adjust target band, and calculate rebalance plan.</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Back & Workflow Link */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
        <Link
          href="/workflows"
          style={{ padding: "0.5rem 1rem", borderRadius: 8, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#cbd5e1", textDecoration: "none", fontSize: "0.8rem", fontWeight: 600 }}
        >
          ← Deploy Autonomous Liquidity Workflow
        </Link>
        <Link
          href="/radar"
          style={{ padding: "0.5rem 1rem", borderRadius: 8, backgroundColor: "rgba(0, 82, 255, 0.15)", border: "1px solid rgba(0, 82, 255, 0.3)", color: "#60a5fa", textDecoration: "none", fontSize: "0.8rem", fontWeight: 600 }}
        >
          Live Arbitrage Radar →
        </Link>
      </div>
    </div>
  );
}
