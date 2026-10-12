"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { sdk } from "@farcaster/miniapp-sdk";

interface FleetAgent {
  id: string;
  name: string;
  role: string;
  dailyCapUsdc: number;
  spentTodayUsdc: number;
  allowedCategories: string[];
  status: "ACTIVE" | "PAUSED" | "THROTTLED";
  callsToday: number;
  lastActive: string;
  tokenKey: string;
}

interface FleetData {
  success: boolean;
  fleetName: string;
  ownerWallet: string;
  builderCode: string;
  summary: {
    totalAgents: number;
    activeAgents: number;
    totalDailyCapUsdc: number;
    totalSpentTodayUsdc: number;
    remainingQuotaUsdc: number;
    totalCallsToday: number;
    killSwitchActive: boolean;
  };
  agents: FleetAgent[];
}

export default function FleetPage() {
  const [data, setData] = useState<FleetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentRole, setNewAgentRole] = useState("");
  const [newAgentCap, setNewAgentCap] = useState("5.0");
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [globalKillSwitch, setGlobalKillSwitch] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadFleet() {
      try {
        const res = await fetch("/api/fleet");
        const json = await res.json();
        if (!cancelled && json.success) {
          setData(json);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    loadFleet();

    try {
      sdk.actions.ready();
    } catch {}

    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleAgentStatus = async (agentId: string, currentStatus: string) => {
    const newStatus = currentStatus === "ACTIVE" ? "PAUSED" : "ACTIVE";
    try {
      await fetch("/api/fleet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "toggle_status", agentId, newStatus }),
      });

      setData((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          agents: prev.agents.map((ag) => (ag.id === agentId ? { ...ag, status: newStatus as any } : ag)),
        };
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAgentName.trim()) return;

    try {
      const res = await fetch("/api/fleet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create_agent",
          name: newAgentName,
          role: newAgentRole || "Autonomous Agent",
          dailyCapUsdc: parseFloat(newAgentCap) || 5.0,
        }),
      });
      const resData = await res.json();
      if (resData.success && resData.agent) {
        setData((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            agents: [resData.agent, ...prev.agents],
            summary: {
              ...prev.summary,
              totalAgents: prev.summary.totalAgents + 1,
              activeAgents: prev.summary.activeAgents + 1,
              totalDailyCapUsdc: prev.summary.totalDailyCapUsdc + resData.agent.dailyCapUsdc,
            },
          };
        });
        setShowAddModal(false);
        setNewAgentName("");
        setNewAgentRole("");
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedToken(text);
    setTimeout(() => setCopiedToken(null), 2000);
  };

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "1.5rem 1rem 4rem" }}>
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
          Multi-Agent Fleet Controller • Base Swarm Quotas
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
          Autonomous Agent Fleet Manager
        </h1>
        <p style={{ color: "#94a3b8", fontSize: "1.05rem", maxWidth: 680, margin: "0 auto 1.5rem" }}>
          Centrally govern, budget, and kill-switch autonomous agent swarms calling x402 Bazaar APIs. Assign daily USDC spending caps and monitor live execution velocity.
        </p>

        <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => setShowAddModal(true)}
            style={{
              padding: "0.6rem 1.25rem",
              borderRadius: 8,
              backgroundColor: "#0052ff",
              color: "#fff",
              fontWeight: 700,
              fontSize: "0.9rem",
              border: "none",
              cursor: "pointer",
            }}
          >
            + Provision New Agent
          </button>
          <button
            onClick={() => setGlobalKillSwitch(!globalKillSwitch)}
            style={{
              padding: "0.6rem 1.25rem",
              borderRadius: 8,
              backgroundColor: globalKillSwitch ? "#ef4444" : "rgba(239, 68, 68, 0.15)",
              border: "1px solid rgba(239, 68, 68, 0.4)",
              color: globalKillSwitch ? "#fff" : "#fca5a5",
              fontWeight: 700,
              fontSize: "0.9rem",
              cursor: "pointer",
            }}
          >
            {globalKillSwitch ? "🛑 FLEET EMERGENCY FROZEN" : "⚠️ Global Emergency Kill-Switch"}
          </button>
          <Link
            href="/workflows"
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
            ⚡ Agent Workflows
          </Link>
        </div>
      </div>

      {/* KPI Stats Bar */}
      {data && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 13rem), 1fr))",
            gap: "1rem",
            marginBottom: "2rem",
          }}
        >
          <div style={{ backgroundColor: "rgba(15, 23, 42, 0.75)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "1.25rem" }}>
            <div style={{ color: "#94a3b8", fontSize: "0.82rem", textTransform: "uppercase", fontWeight: 700 }}>Total Fleet Swarm</div>
            <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "#60a5fa", margin: "0.35rem 0 0.2rem" }}>
              {data.summary.activeAgents} / {data.summary.totalAgents} Active
            </div>
            <div style={{ color: "#64748b", fontSize: "0.78rem" }}>Registered bots</div>
          </div>

          <div style={{ backgroundColor: "rgba(15, 23, 42, 0.75)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "1.25rem" }}>
            <div style={{ color: "#94a3b8", fontSize: "0.82rem", textTransform: "uppercase", fontWeight: 700 }}>Daily Budget Cap</div>
            <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "#10b981", margin: "0.35rem 0 0.2rem" }}>
              ${data.summary.totalDailyCapUsdc.toFixed(2)} USDC
            </div>
            <div style={{ color: "#64748b", fontSize: "0.78rem" }}>Automated daily limit</div>
          </div>

          <div style={{ backgroundColor: "rgba(15, 23, 42, 0.75)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "1.25rem" }}>
            <div style={{ color: "#94a3b8", fontSize: "0.82rem", textTransform: "uppercase", fontWeight: 700 }}>Spent Today</div>
            <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "#f59e0b", margin: "0.35rem 0 0.2rem" }}>
              ${data.summary.totalSpentTodayUsdc.toFixed(2)} USDC
            </div>
            <div style={{ color: "#64748b", fontSize: "0.78rem" }}>Across all 402 endpoints</div>
          </div>

          <div style={{ backgroundColor: "rgba(15, 23, 42, 0.75)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "1.25rem" }}>
            <div style={{ color: "#94a3b8", fontSize: "0.82rem", textTransform: "uppercase", fontWeight: 700 }}>Total Calls (24h)</div>
            <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "#a855f7", margin: "0.35rem 0 0.2rem" }}>
              {data.summary.totalCallsToday.toLocaleString()}
            </div>
            <div style={{ color: "#64748b", fontSize: "0.78rem" }}>EIP-3009 micro-queries</div>
          </div>
        </div>
      )}

      {/* Agents List Grid */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "4rem 0", color: "#64748b" }}>Loading swarm telemetry...</div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))",
            gap: "1.25rem",
          }}
        >
          {data?.agents.map((agent) => {
            const usagePercent = Math.min(100, Math.round((agent.spentTodayUsdc / agent.dailyCapUsdc) * 100));
            const isPaused = agent.status === "PAUSED" || globalKillSwitch;

            return (
              <div
                key={agent.id}
                style={{
                  backgroundColor: "rgba(15, 23, 42, 0.75)",
                  border: isPaused ? "1px solid rgba(239, 68, 68, 0.35)" : "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 14,
                  padding: "1.25rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.85rem",
                  position: "relative",
                  boxShadow: isPaused ? "0 4px 20px rgba(239,68,68,0.1)" : "none",
                }}
              >
                {/* Header row */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: "1.1rem", color: "#f8fafc" }}>{agent.name}</div>
                    <div style={{ fontSize: "0.8rem", color: "#94a3b8", marginTop: "0.15rem" }}>{agent.role}</div>
                  </div>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      fontWeight: 800,
                      padding: "0.2rem 0.5rem",
                      borderRadius: 6,
                      backgroundColor: isPaused
                        ? "rgba(239, 68, 68, 0.2)"
                        : agent.status === "THROTTLED"
                        ? "rgba(245, 158, 11, 0.2)"
                        : "rgba(16, 185, 129, 0.2)",
                      color: isPaused ? "#f87171" : agent.status === "THROTTLED" ? "#fbbf24" : "#34d399",
                    }}
                  >
                    {isPaused ? "STOPPED" : agent.status}
                  </span>
                </div>

                {/* Quota Progress Bar */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", marginBottom: "0.35rem" }}>
                    <span style={{ color: "#94a3b8" }}>Daily Spend Quota</span>
                    <strong style={{ color: usagePercent > 90 ? "#ef4444" : "#e2e8f0" }}>
                      ${agent.spentTodayUsdc.toFixed(2)} / ${agent.dailyCapUsdc.toFixed(2)} USDC ({usagePercent}%)
                    </strong>
                  </div>
                  <div style={{ width: "100%", height: 6, backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 999, overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        width: `${usagePercent}%`,
                        backgroundColor: usagePercent > 90 ? "#ef4444" : usagePercent > 70 ? "#f59e0b" : "#10b981",
                        transition: "width 0.3s ease",
                      }}
                    />
                  </div>
                </div>

                {/* Allowed Categories & Metrics */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.75rem", color: "#64748b" }}>
                  <span>Calls: <strong style={{ color: "#f1f5f9" }}>{agent.callsToday}</strong></span>
                  <span>Last active: <strong style={{ color: "#cbd5e1" }}>{agent.lastActive}</strong></span>
                </div>

                {/* Scoped Bearer Token & Kill Switch Controls */}
                <div
                  style={{
                    borderTop: "1px solid rgba(255,255,255,0.06)",
                    paddingTop: "0.75rem",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  <button
                    onClick={() => handleCopy(agent.tokenKey)}
                    style={{
                      padding: "0.35rem 0.65rem",
                      borderRadius: 6,
                      border: "1px solid rgba(255,255,255,0.1)",
                      backgroundColor: "rgba(255,255,255,0.03)",
                      color: copiedToken === agent.tokenKey ? "#10b981" : "#94a3b8",
                      fontSize: "0.75rem",
                      cursor: "pointer",
                      fontFamily: "monospace",
                    }}
                  >
                    {copiedToken === agent.tokenKey ? "✓ Token Copied" : `${agent.tokenKey.slice(0, 12)}…`}
                  </button>

                  <button
                    onClick={() => handleToggleAgentStatus(agent.id, agent.status)}
                    style={{
                      padding: "0.35rem 0.75rem",
                      borderRadius: 6,
                      border: "none",
                      backgroundColor: isPaused ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)",
                      color: isPaused ? "#34d399" : "#f87171",
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {isPaused ? "▶ Resume Agent" : "⏸ Pause Agent"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Provision New Agent Modal */}
      {showAddModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "1rem",
          }}
        >
          <div
            style={{
              backgroundColor: "#0b0f19",
              border: "1px solid rgba(0, 82, 255, 0.4)",
              borderRadius: 14,
              padding: "1.5rem",
              maxWidth: 460,
              width: "100%",
            }}
          >
            <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.25rem", color: "#f8fafc" }}>Provision Swarm Sub-Agent</h2>
            <p style={{ color: "#94a3b8", fontSize: "0.85rem", margin: "0 0 1.25rem" }}>
              Assign a dedicated daily spending budget and generate an instant x402 bearer token for your agent.
            </p>

            <form onSubmit={handleCreateAgent} style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.75rem", color: "#cbd5e1", marginBottom: "0.3rem" }}>
                  Agent Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Higher Token Arbitrage Bot"
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "0.6rem",
                    borderRadius: 8,
                    backgroundColor: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    color: "#fff",
                    fontSize: "0.85rem",
                  }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.75rem", color: "#cbd5e1", marginBottom: "0.3rem" }}>
                  Primary Mission / Role
                </label>
                <input
                  type="text"
                  placeholder="e.g. Scans liquidity pools & executes trades"
                  value={newAgentRole}
                  onChange={(e) => setNewAgentRole(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "0.6rem",
                    borderRadius: 8,
                    backgroundColor: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    color: "#fff",
                    fontSize: "0.85rem",
                  }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.75rem", color: "#cbd5e1", marginBottom: "0.3rem" }}>
                  Daily Spend Cap (USDC)
                </label>
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="1000"
                  value={newAgentCap}
                  onChange={(e) => setNewAgentCap(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "0.6rem",
                    borderRadius: 8,
                    backgroundColor: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    color: "#fff",
                    fontSize: "0.85rem",
                  }}
                />
              </div>

              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                <button
                  type="submit"
                  style={{
                    flex: 1,
                    padding: "0.65rem",
                    borderRadius: 8,
                    backgroundColor: "#0052ff",
                    color: "#fff",
                    border: "none",
                    fontWeight: 700,
                    fontSize: "0.85rem",
                    cursor: "pointer",
                  }}
                >
                  Confirm & Provision
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  style={{
                    padding: "0.65rem 1rem",
                    borderRadius: 8,
                    backgroundColor: "transparent",
                    color: "#94a3b8",
                    border: "1px solid rgba(255,255,255,0.15)",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
