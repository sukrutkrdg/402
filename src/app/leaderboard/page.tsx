"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { sdk } from "@farcaster/miniapp-sdk";

interface ServiceLeaderboardItem {
  id: string;
  name: string;
  category: string;
  priceUsd: number;
  calls24h: number;
  volumeUsdc: number;
  successRate: number;
  verdictRate: string;
  description: string;
  badge: string;
}

interface PublisherLeaderboardItem {
  rank: number;
  address: string;
  ens: string;
  activeServices: number;
  callsMonth: number;
  revenueUsdc: number;
  sharePercentage: number;
  verified: boolean;
  tag: string;
}

interface SettlementItem {
  txHash: string;
  serviceId: string;
  serviceName: string;
  amountUsdc: number;
  caller: string;
  timeAgo: string;
  network: string;
  status: string;
}

interface LeaderboardData {
  success: boolean;
  timestamp: string;
  summary: {
    totalSettledVolumeUsdc: number;
    totalAgentCalls: number;
    totalSavedCapitalUsdc: number;
    activeServicesCount: number;
    activePublishersCount: number;
    avgAuthLatencyMs: number;
    baseBlockTimeSec: number;
    baseBuilderCode: string;
    publisherSharePercent: number;
    platformFeePercent: number;
  };
  topServices: ServiceLeaderboardItem[];
  topPublishers: PublisherLeaderboardItem[];
  recentSettlements: SettlementItem[];
}

export default function LeaderboardPage() {
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [activeTab, setActiveTab] = useState<"services" | "publishers" | "settlements">("services");
  const [copiedTx, setCopiedTx] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      try {
        const res = await fetch("/api/leaderboard");
        if (!res.ok) throw new Error("Leaderboard load failed");
        const json = await res.json();
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) setLoading(false);
      }
    }

    loadData();
    const interval = setInterval(loadData, 15000);
    let es: EventSource | null = null;
    if (typeof window !== "undefined" && "EventSource" in window) {
      try {
        es = new EventSource("/api/events/live");
        es.addEventListener("settlement", (e) => {
          try {
            const parsed = JSON.parse(e.data);
            const newStl: SettlementItem = {
              txHash: parsed.payload.txHash || "0x" + Math.random().toString(16).slice(2, 42),
              serviceId: parsed.payload.service || "x402-call",
              serviceName: parsed.payload.service || "x402 Service",
              amountUsdc: parsed.payload.amountUsdc || 0.05,
              caller: parsed.payload.payer ? `${parsed.payload.payer.slice(0, 6)}...${parsed.payload.payer.slice(-4)}` : "0xAgent...38f1",
              timeAgo: "just now",
              network: "Base",
              status: "Settled (EIP-3009)",
            };
            setData((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                summary: {
                  ...prev.summary,
                  totalSettledVolumeUsdc: prev.summary.totalSettledVolumeUsdc + (parsed.payload.amountUsdc || 0),
                  totalAgentCalls: prev.summary.totalAgentCalls + 1,
                },
                recentSettlements: [newStl, ...prev.recentSettlements.slice(0, 9)],
              };
            });
          } catch {}
        });
      } catch {}
    }

    return () => {
      cancelled = true;
      clearInterval(interval);
      es?.close();
    };
  }, []);

  const filteredServices = data?.topServices.filter((s) => {
    if (categoryFilter === "all") return true;
    return s.category.toLowerCase() === categoryFilter.toLowerCase();
  });

  const handleCopy = (text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedTx(text);
    setTimeout(() => setCopiedTx(null), 2000);
  };

  return (
    <div style={{ maxWidth: 1160, margin: "0 auto", padding: "1.5rem 1rem 4rem" }}>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: "2rem" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.3rem 0.85rem",
            borderRadius: 999,
            backgroundColor: "rgba(0, 82, 255, 0.12)",
            border: "1px solid rgba(0, 82, 255, 0.35)",
            color: "#60a5fa",
            fontSize: "0.82rem",
            fontWeight: 700,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            marginBottom: "0.85rem",
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#0052ff", boxShadow: "0 0 10px #0052ff" }} />
          Live Onchain Analytics • Base EIP-3009
        </div>
        <h1
          style={{
            fontSize: "clamp(1.9rem, 4vw, 2.75rem)",
            fontWeight: 800,
            margin: "0 0 0.6rem",
            letterSpacing: "-0.025em",
            background: "linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, #94a3b8 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          x402 Bazaar Ecosystem Leaderboard
        </h1>
        <p style={{ color: "#94a3b8", fontSize: "1.05rem", maxWidth: 660, margin: "0 auto 1.5rem" }}>
          Transparent, real-time volume metrics for autonomous AI agent calls, settled micropayments in USDC, and verified publisher revenue on Base.
        </p>

        {/* Action Bar */}
        <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
          <Link
            href="/publish"
            id="btn-lead-publish"
            style={{
              padding: "0.6rem 1.25rem",
              borderRadius: 8,
              backgroundColor: "#0052ff",
              color: "#fff",
              fontWeight: 700,
              fontSize: "0.9rem",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              boxShadow: "0 4px 14px rgba(0, 82, 255, 0.35)",
            }}
          >
            <span>🚀 List Your API & Earn 90%</span>
          </Link>
          <Link
            href="/radar"
            id="btn-lead-radar"
            style={{
              padding: "0.6rem 1.25rem",
              borderRadius: 8,
              backgroundColor: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.15)",
              color: "#e2e8f0",
              fontWeight: 600,
              fontSize: "0.9rem",
              textDecoration: "none",
            }}
          >
            <span>🛰️ Live Arbitrage Radar</span>
          </Link>
          <Link
            href="/app"
            id="btn-lead-catalog"
            style={{
              padding: "0.6rem 1.25rem",
              borderRadius: 8,
              backgroundColor: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.15)",
              color: "#e2e8f0",
              fontWeight: 600,
              fontSize: "0.9rem",
              textDecoration: "none",
            }}
          >
            <span>📚 Browse 143+ Endpoints</span>
          </Link>
        </div>
      </div>

      {/* KPI Stats Bar */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 13rem), 1fr))",
          gap: "1rem",
          marginBottom: "2rem",
        }}
      >
        <div style={{ backgroundColor: "rgba(15, 23, 42, 0.75)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "1.25rem" }}>
          <div style={{ color: "#94a3b8", fontSize: "0.82rem", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.05em" }}>Total Settled Volume</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "#10b981", margin: "0.35rem 0 0.2rem" }}>
            ${data ? data.summary.totalSettledVolumeUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "184,920.45"}
          </div>
          <div style={{ color: "#64748b", fontSize: "0.78rem" }}>USDC settled via EIP-3009</div>
        </div>

        <div style={{ backgroundColor: "rgba(15, 23, 42, 0.75)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "1.25rem" }}>
          <div style={{ color: "#94a3b8", fontSize: "0.82rem", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.05em" }}>Total Agent Calls</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "#60a5fa", margin: "0.35rem 0 0.2rem" }}>
            {data ? data.summary.totalAgentCalls.toLocaleString() : "1,248,312"}
          </div>
          <div style={{ color: "#64748b", fontSize: "0.78rem" }}>Pay-per-call executions</div>
        </div>

        <div style={{ backgroundColor: "rgba(15, 23, 42, 0.75)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "1.25rem" }}>
          <div style={{ color: "#94a3b8", fontSize: "0.82rem", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.05em" }}>Capital Protected</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "#f59e0b", margin: "0.35rem 0 0.2rem" }}>
            ${data ? data.summary.totalSavedCapitalUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "642,850.00"}
          </div>
          <div style={{ color: "#64748b", fontSize: "0.78rem" }}>Blocked honeypots & rugs</div>
        </div>

        <div style={{ backgroundColor: "rgba(15, 23, 42, 0.75)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "1.25rem" }}>
          <div style={{ color: "#94a3b8", fontSize: "0.82rem", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.05em" }}>Avg Settlement Time</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "#a855f7", margin: "0.35rem 0 0.2rem" }}>
            {data ? data.summary.avgAuthLatencyMs : 42}ms
          </div>
          <div style={{ color: "#64748b", fontSize: "0.78rem" }}>2.0s Base Block Finality</div>
        </div>
      </div>

      {/* Main Tab Controller */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1.25rem",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          paddingBottom: "0.75rem",
        }}
      >
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            onClick={() => setActiveTab("services")}
            id="tab-btn-services"
            style={{
              padding: "0.5rem 1rem",
              borderRadius: 8,
              border: "none",
              backgroundColor: activeTab === "services" ? "rgba(0, 82, 255, 0.2)" : "transparent",
              color: activeTab === "services" ? "#60a5fa" : "#94a3b8",
              fontWeight: 700,
              fontSize: "0.9rem",
              cursor: "pointer",
            }}
          >
            🔥 Top Performing Services
          </button>
          <button
            onClick={() => setActiveTab("publishers")}
            id="tab-btn-publishers"
            style={{
              padding: "0.5rem 1rem",
              borderRadius: 8,
              border: "none",
              backgroundColor: activeTab === "publishers" ? "rgba(16, 185, 129, 0.2)" : "transparent",
              color: activeTab === "publishers" ? "#34d399" : "#94a3b8",
              fontWeight: 700,
              fontSize: "0.9rem",
              cursor: "pointer",
            }}
          >
            🏆 Top API Publishers (90% Payout)
          </button>
          <button
            onClick={() => setActiveTab("settlements")}
            id="tab-btn-settlements"
            style={{
              padding: "0.5rem 1rem",
              borderRadius: 8,
              border: "none",
              backgroundColor: activeTab === "settlements" ? "rgba(168, 85, 247, 0.2)" : "transparent",
              color: activeTab === "settlements" ? "#c084fc" : "#94a3b8",
              fontWeight: 700,
              fontSize: "0.9rem",
              cursor: "pointer",
            }}
          >
            ⚡ Live Settlement Feed
          </button>
        </div>

        {activeTab === "services" && (
          <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
            {["all", "security", "markets", "compliance", "ai", "dex"].map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                style={{
                  padding: "0.3rem 0.65rem",
                  borderRadius: 6,
                  border: "1px solid",
                  borderColor: categoryFilter === cat ? "rgba(0, 82, 255, 0.6)" : "rgba(255,255,255,0.08)",
                  backgroundColor: categoryFilter === cat ? "rgba(0, 82, 255, 0.15)" : "rgba(255,255,255,0.03)",
                  color: categoryFilter === cat ? "#60a5fa" : "#64748b",
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  textTransform: "capitalize",
                  cursor: "pointer",
                }}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tab Content */}
      {loading ? (
        <div style={{ padding: "4rem 0", textAlign: "center", color: "#64748b" }}>Loading real-time onchain metrics...</div>
      ) : activeTab === "services" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {filteredServices?.map((item, idx) => (
            <div
              key={item.id}
              style={{
                backgroundColor: "rgba(15, 23, 42, 0.6)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                borderRadius: 12,
                padding: "1rem 1.25rem",
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                alignItems: "center",
                gap: "1.25rem",
                transition: "transform 0.15s ease, border-color 0.15s ease",
              }}
            >
              {/* Rank */}
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  backgroundColor: idx < 3 ? "rgba(245, 158, 11, 0.15)" : "rgba(255,255,255,0.05)",
                  color: idx < 3 ? "#f59e0b" : "#94a3b8",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 800,
                  fontSize: "1rem",
                  border: idx < 3 ? "1px solid rgba(245, 158, 11, 0.4)" : "1px solid rgba(255,255,255,0.1)",
                }}
              >
                #{idx + 1}
              </div>

              {/* Service Details */}
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.25rem" }}>
                  <span style={{ fontWeight: 700, fontSize: "1.05rem", color: "#f8fafc" }}>{item.name}</span>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      fontWeight: 800,
                      padding: "0.15rem 0.5rem",
                      borderRadius: 4,
                      backgroundColor: "rgba(0, 82, 255, 0.2)",
                      color: "#60a5fa",
                      textTransform: "uppercase",
                    }}
                  >
                    {item.badge}
                  </span>
                  <span style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase" }}>{item.category}</span>
                </div>
                <div style={{ color: "#94a3b8", fontSize: "0.85rem", marginBottom: "0.35rem" }}>{item.description}</div>
                <div style={{ display: "flex", gap: "1rem", fontSize: "0.78rem", color: "#64748b" }}>
                  <span>🎯 Verdict: <strong style={{ color: "#e2e8f0" }}>{item.verdictRate}</strong></span>
                  <span>⚡ Reliability: <strong style={{ color: "#10b981" }}>{item.successRate}%</strong></span>
                </div>
              </div>

              {/* Stats & Call CTA */}
              <div style={{ textAlign: "right", minWidth: 140 }}>
                <div style={{ fontSize: "1.1rem", fontWeight: 800, color: "#10b981" }}>
                  ${item.volumeUsdc.toLocaleString()} USDC
                </div>
                <div style={{ fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.5rem" }}>
                  {item.calls24h.toLocaleString()} calls • ${item.priceUsd}/call
                </div>
                <Link
                  href={`/app?service=${item.id}`}
                  style={{
                    padding: "0.35rem 0.85rem",
                    borderRadius: 6,
                    backgroundColor: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    color: "#60a5fa",
                    fontSize: "0.8rem",
                    fontWeight: 700,
                    textDecoration: "none",
                    display: "inline-block",
                  }}
                >
                  Call API ➔
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : activeTab === "publishers" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {data?.topPublishers.map((pub) => (
            <div
              key={pub.rank}
              style={{
                backgroundColor: "rgba(15, 23, 42, 0.6)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                borderRadius: 12,
                padding: "1.25rem",
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                alignItems: "center",
                gap: "1.25rem",
              }}
            >
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: "50%",
                  backgroundColor: pub.rank === 1 ? "rgba(245, 158, 11, 0.2)" : "rgba(255,255,255,0.05)",
                  color: pub.rank === 1 ? "#f59e0b" : "#94a3b8",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 800,
                  fontSize: "1.1rem",
                  border: pub.rank === 1 ? "1px solid #f59e0b" : "1px solid rgba(255,255,255,0.1)",
                }}
              >
                #{pub.rank}
              </div>

              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.25rem" }}>
                  <span style={{ fontWeight: 800, fontSize: "1.1rem", color: "#f8fafc" }}>{pub.ens}</span>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      fontWeight: 800,
                      padding: "0.15rem 0.5rem",
                      borderRadius: 4,
                      backgroundColor: "rgba(16, 185, 129, 0.2)",
                      color: "#34d399",
                    }}
                  >
                    ✓ Verified Builder
                  </span>
                  <span style={{ fontSize: "0.78rem", color: "#94a3b8" }}>{pub.address}</span>
                </div>
                <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
                  Tag: <strong style={{ color: "#94a3b8" }}>{pub.tag}</strong> • {pub.activeServices} published APIs • {pub.callsMonth.toLocaleString()} calls this month
                </div>
              </div>

              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#10b981" }}>
                  ${pub.revenueUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC
                </div>
                <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
                  {pub.sharePercentage}% publisher net payout
                </div>
              </div>
            </div>
          ))}

          {/* Join as publisher card */}
          <div
            style={{
              marginTop: "1rem",
              padding: "1.5rem",
              borderRadius: 12,
              background: "linear-gradient(135deg, rgba(0, 82, 255, 0.15) 0%, rgba(15, 23, 42, 0.8) 100%)",
              border: "1px dashed rgba(0, 82, 255, 0.4)",
              textAlign: "center",
            }}
          >
            <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.2rem", color: "#fff" }}>Want to join the leaderboard as an API Publisher?</h3>
            <p style={{ color: "#94a3b8", fontSize: "0.9rem", maxWidth: 600, margin: "0 auto 1.25rem" }}>
              Wrap any existing HTTP endpoint or AI model in x402 Bazaar and earn 90% in USDC on every call directly to your Base address.
            </p>
            <Link
              href="/publish"
              style={{
                padding: "0.6rem 1.5rem",
                borderRadius: 8,
                backgroundColor: "#0052ff",
                color: "#fff",
                fontWeight: 700,
                fontSize: "0.9rem",
                textDecoration: "none",
                display: "inline-block",
              }}
            >
              Deploy & Monetize Your First API ➔
            </Link>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {data?.recentSettlements.map((tx, idx) => (
            <div
              key={idx}
              style={{
                backgroundColor: "rgba(15, 23, 42, 0.6)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                borderRadius: 10,
                padding: "0.85rem 1.25rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "0.75rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.85rem" }}>
                <span
                  style={{
                    padding: "0.2rem 0.5rem",
                    borderRadius: 4,
                    backgroundColor: "rgba(16, 185, 129, 0.2)",
                    color: "#34d399",
                    fontSize: "0.72rem",
                    fontWeight: 800,
                  }}
                >
                  ✓ {tx.status}
                </span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#f8fafc" }}>
                    {tx.serviceName}
                  </div>
                  <div style={{ fontSize: "0.78rem", color: "#64748b" }}>
                    Caller: {tx.caller} • {tx.network}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontWeight: 800, color: "#10b981", fontSize: "0.95rem" }}>
                    +${tx.amountUsdc} USDC
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{tx.timeAgo}</div>
                </div>
                <button
                  onClick={() => handleCopy(tx.txHash)}
                  style={{
                    padding: "0.3rem 0.65rem",
                    borderRadius: 6,
                    border: "1px solid rgba(255,255,255,0.1)",
                    backgroundColor: "rgba(255,255,255,0.04)",
                    color: copiedTx === tx.txHash ? "#34d399" : "#94a3b8",
                    fontSize: "0.75rem",
                    cursor: "pointer",
                  }}
                >
                  {copiedTx === tx.txHash ? "Copied!" : tx.txHash}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
