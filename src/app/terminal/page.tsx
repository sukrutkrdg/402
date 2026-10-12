"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";

interface TerminalLog {
  time: string;
  type: "info" | "success" | "warn" | "error" | "telemetry";
  message: string;
}

interface CommandResult {
  command?: string;
  verdict?: string;
  score?: number;
  spreadBps?: number;
  direction?: string;
  estProfitPer1kUsd?: number;
  isHoneypot?: boolean;
  receiptUrl?: string;
  paymentProof?: string;
  [key: string]: any;
}

export default function TerminalPage() {
  const [logs, setLogs] = useState<TerminalLog[]>([
    { time: "INIT", type: "info", message: "x402 Bazaar Autonomous Terminal v2.4 initialized." },
    { time: "AUTH", type: "telemetry", message: "Attributed Base Builder Code: bc_pa0gqlv1" },
    { time: "READY", type: "success", message: "Connected to Base RPC relayer cluster (38ms latency). Type 'help' or click presets to execute." },
  ]);
  const [inputCmd, setInputCmd] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastResult, setLastResult] = useState<CommandResult | null>(null);
  const [gasGwei, setGasGwei] = useState("0.002");
  const [copiedReceipt, setCopiedReceipt] = useState(false);
  const consoleBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    consoleBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Minor gas fluctuation simulation for Bloomberg realism
  useEffect(() => {
    const interval = setInterval(() => {
      setGasGwei((0.0018 + Math.random() * 0.0008).toFixed(4));
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const executeCommand = async (cmdToRun: string) => {
    if (!cmdToRun.trim() || loading) return;
    setLoading(true);

    const userLog: TerminalLog = {
      time: new Date().toLocaleTimeString(),
      type: "info",
      message: `> ${cmdToRun}`,
    };
    setLogs((prev) => [...prev, userLog]);

    try {
      const res = await fetch("/api/terminal/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: cmdToRun }),
      });
      const data = await res.json();

      if (data.logs && Array.isArray(data.logs)) {
        setLogs((prev) => [...prev, ...data.logs]);
      }
      if (data.result) {
        setLastResult(data.result);
      }
    } catch {
      setLogs((prev) => [
        ...prev,
        {
          time: new Date().toLocaleTimeString(),
          type: "error",
          message: "Execution timed out or network error encountered.",
        },
      ]);
    } finally {
      setLoading(false);
      setInputCmd("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      executeCommand(inputCmd);
    }
  };

  const handleCopyProof = (text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedReceipt(true);
    setTimeout(() => setCopiedReceipt(false), 2000);
  };

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem 1rem 4rem", fontFamily: "var(--font-geist-mono, monospace)" }}>
      {/* Top Telemetry Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.75rem",
          backgroundColor: "#060913",
          border: "1px solid rgba(0, 82, 255, 0.3)",
          borderRadius: 12,
          padding: "0.75rem 1.25rem",
          marginBottom: "1.25rem",
          fontSize: "0.82rem",
          color: "#94a3b8",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.85rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#10b981", boxShadow: "0 0 8px #10b981" }} />
            <strong style={{ color: "#f8fafc" }}>AGENT TERMINAL</strong>
          </div>
          <span style={{ color: "rgba(255,255,255,0.2)" }}>|</span>
          <span>Base Mainnet (8453)</span>
          <span style={{ color: "rgba(255,255,255,0.2)" }}>|</span>
          <span>Gas: <strong style={{ color: "#38bdf8" }}>{gasGwei} Gwei</strong></span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <span>Builder: <code style={{ color: "#60a5fa" }}>bc_pa0gqlv1</code></span>
          <span>EIP-3009: <strong style={{ color: "#10b981" }}>ACTIVE</strong></span>
          <Link
            href="/leaderboard"
            style={{
              padding: "0.25rem 0.65rem",
              borderRadius: 6,
              backgroundColor: "rgba(0, 82, 255, 0.15)",
              color: "#60a5fa",
              textDecoration: "none",
              fontSize: "0.75rem",
              fontWeight: 700,
            }}
          >
            Leaderboard ↗
          </Link>
        </div>
      </div>

      {/* Main Grid: Left Control Panel + Center Console + Right Inspector */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 20rem), 1fr))",
          gap: "1.25rem",
        }}
      >
        {/* Left Column: Preset Intent Launcher */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div
            style={{
              backgroundColor: "rgba(11, 15, 25, 0.85)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 12,
              padding: "1.25rem",
            }}
          >
            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "#cbd5e1", marginBottom: "0.85rem" }}>
              ⚡ QUICK AGENT INTENTS
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <button
                onClick={() => executeCommand("audit 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed")}
                style={{
                  padding: "0.6rem 0.85rem",
                  borderRadius: 8,
                  backgroundColor: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "#f8fafc",
                  fontSize: "0.8rem",
                  textAlign: "left",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>🛡️ Pre-Trade Honeypot Audit</span>
                <span style={{ color: "#60a5fa", fontSize: "0.72rem" }}>$0.05</span>
              </button>

              <button
                onClick={() => executeCommand("spread 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed")}
                style={{
                  padding: "0.6rem 0.85rem",
                  borderRadius: 8,
                  backgroundColor: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "#f8fafc",
                  fontSize: "0.8rem",
                  textAlign: "left",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>📊 Cross-DEX Arbitrage Spread</span>
                <span style={{ color: "#60a5fa", fontSize: "0.72rem" }}>$0.02</span>
              </button>

              <button
                onClick={() => executeCommand("clanker 0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb")}
                style={{
                  padding: "0.6rem 0.85rem",
                  borderRadius: 8,
                  backgroundColor: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "#f8fafc",
                  fontSize: "0.8rem",
                  textAlign: "left",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>🤖 Clanker Factory Verification</span>
                <span style={{ color: "#60a5fa", fontSize: "0.72rem" }}>$0.03</span>
              </button>

              <button
                onClick={() => executeCommand("status")}
                style={{
                  padding: "0.6rem 0.85rem",
                  borderRadius: 8,
                  backgroundColor: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "#f8fafc",
                  fontSize: "0.8rem",
                  textAlign: "left",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>🟢 Network & Relayer Telemetry</span>
                <span style={{ color: "#10b981", fontSize: "0.72rem" }}>FREE</span>
              </button>

              <button
                onClick={() => executeCommand("simulate swap-intent")}
                style={{
                  padding: "0.6rem 0.85rem",
                  borderRadius: 8,
                  backgroundColor: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "#f8fafc",
                  fontSize: "0.8rem",
                  textAlign: "left",
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>⚡ Simulate x402 EIP-3009 Settlement</span>
                <span style={{ color: "#60a5fa", fontSize: "0.72rem" }}>$0.01</span>
              </button>
            </div>
          </div>

          {/* Integration Specs */}
          <div
            style={{
              backgroundColor: "rgba(11, 15, 25, 0.85)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 12,
              padding: "1.25rem",
              fontSize: "0.8rem",
            }}
          >
            <div style={{ fontWeight: 700, color: "#94a3b8", marginBottom: "0.5rem" }}>🤖 FOR AGENTS</div>
            <p style={{ color: "#64748b", margin: "0 0 0.85rem", lineHeight: 1.5 }}>
              Trigger these exact endpoints from your ElizaOS or Coinbase AgentKit fleet via HTTP 402 with zero API keys.
            </p>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Link
                href="/agents"
                style={{
                  padding: "0.4rem 0.85rem",
                  borderRadius: 6,
                  backgroundColor: "rgba(0, 82, 255, 0.15)",
                  color: "#60a5fa",
                  textDecoration: "none",
                  fontWeight: 700,
                  fontSize: "0.75rem",
                }}
              >
                Agent Specs →
              </Link>
              <Link
                href="/publish"
                style={{
                  padding: "0.4rem 0.85rem",
                  borderRadius: 6,
                  backgroundColor: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  color: "#94a3b8",
                  textDecoration: "none",
                  fontWeight: 600,
                  fontSize: "0.75rem",
                }}
              >
                Publish API (90%) →
              </Link>
            </div>
          </div>
        </div>

        {/* Center & Right Combined: Interactive Terminal Screen */}
        <div
          style={{
            gridColumn: "span 2",
            backgroundColor: "#030712",
            border: "1px solid rgba(0, 82, 255, 0.35)",
            borderRadius: 12,
            display: "flex",
            flexDirection: "column",
            minHeight: 480,
            boxShadow: "0 10px 40px rgba(0, 82, 255, 0.15)",
            overflow: "hidden",
          }}
        >
          {/* Terminal Titlebar */}
          <div
            style={{
              padding: "0.6rem 1rem",
              backgroundColor: "rgba(255,255,255,0.02)",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "0.75rem",
              color: "#64748b",
            }}
          >
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#ef4444" }} />
              <span style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#f59e0b" }} />
              <span style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#10b981" }} />
              <span style={{ marginLeft: "0.5rem", color: "#94a3b8" }}>x402-bazaar-agent-cli (bash)</span>
            </div>
            <button
              onClick={() => setLogs([{ time: "CLEAR", type: "info", message: "Console buffer cleared." }])}
              style={{
                background: "none",
                border: "none",
                color: "#64748b",
                cursor: "pointer",
                fontSize: "0.72rem",
              }}
            >
              Clear Buffer
            </button>
          </div>

          {/* Console Output Area */}
          <div
            style={{
              flex: 1,
              padding: "1rem",
              overflowY: "auto",
              maxHeight: 380,
              display: "flex",
              flexDirection: "column",
              gap: "0.35rem",
              fontSize: "0.82rem",
            }}
          >
            {logs.map((log, index) => {
              const color =
                log.type === "success"
                  ? "#10b981"
                  : log.type === "telemetry"
                  ? "#38bdf8"
                  : log.type === "warn"
                  ? "#f59e0b"
                  : log.type === "error"
                  ? "#ef4444"
                  : "#94a3b8";

              return (
                <div key={index} style={{ display: "flex", gap: "0.75rem", lineHeight: 1.45 }}>
                  <span style={{ color: "#475569", flexShrink: 0 }}>[{log.time}]</span>
                  <span style={{ color }}>{log.message}</span>
                </div>
              );
            })}
            {loading && (
              <div style={{ color: "#38bdf8", display: "flex", gap: "0.5rem" }}>
                <span>[SYNC]</span>
                <span>Resolving EIP-3009 payment route on Base...</span>
              </div>
            )}
            <div ref={consoleBottomRef} />
          </div>

          {/* Command Prompt Input */}
          <div
            style={{
              padding: "0.75rem 1rem",
              backgroundColor: "rgba(0,0,0,0.5)",
              borderTop: "1px solid rgba(255,255,255,0.08)",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <span style={{ color: "#10b981", fontWeight: 800 }}>agent@402:~$</span>
            <input
              type="text"
              value={inputCmd}
              onChange={(e) => setInputCmd(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type command (e.g. audit 0x4ed4... or spread 0x4ed4...) and hit Enter"
              disabled={loading}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#f8fafc",
                fontSize: "0.85rem",
                fontFamily: "inherit",
              }}
            />
            <button
              onClick={() => executeCommand(inputCmd)}
              disabled={loading || !inputCmd.trim()}
              style={{
                padding: "0.35rem 0.85rem",
                borderRadius: 6,
                backgroundColor: "#0052ff",
                color: "#fff",
                border: "none",
                fontWeight: 700,
                fontSize: "0.75rem",
                cursor: "pointer",
              }}
            >
              RUN
            </button>
          </div>

          {/* Last Result Inspector Card */}
          {lastResult && (
            <div
              style={{
                padding: "0.85rem 1rem",
                backgroundColor: "rgba(0, 82, 255, 0.08)",
                borderTop: "1px solid rgba(0, 82, 255, 0.2)",
                fontSize: "0.8rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "0.75rem",
              }}
            >
              <div>
                <strong style={{ color: "#60a5fa" }}>Latest Pipeline Output:</strong>{" "}
                <span style={{ color: "#cbd5e1" }}>
                  {lastResult.verdict ? `Verdict: ${lastResult.verdict}` : lastResult.status || "Execution Complete"}
                </span>
                {lastResult.receiptUrl && (
                  <Link
                    href={lastResult.receiptUrl}
                    style={{ marginLeft: "0.75rem", color: "#38bdf8", textDecoration: "underline" }}
                  >
                    View Verified Audit Receipt ↗
                  </Link>
                )}
              </div>
              {lastResult.paymentProof && (
                <button
                  onClick={() => handleCopyProof(lastResult.paymentProof || "")}
                  style={{
                    padding: "0.25rem 0.65rem",
                    borderRadius: 4,
                    border: "1px solid rgba(255,255,255,0.15)",
                    backgroundColor: "rgba(255,255,255,0.05)",
                    color: copiedReceipt ? "#10b981" : "#94a3b8",
                    fontSize: "0.72rem",
                    cursor: "pointer",
                  }}
                >
                  {copiedReceipt ? "✓ Proof Copied" : "Copy EIP-3009 Proof"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
