"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { sdk } from "@farcaster/miniapp-sdk";

interface WorkflowStep {
  serviceId: string;
  name: string;
  costUsdc: number;
  description: string;
  condition?: string;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  category: "trading" | "security" | "arbitrage" | "compliance";
  description: string;
  badge: string;
  totalCostUsdc: number;
  estExecutionTimeMs: number;
  steps: WorkflowStep[];
  codeSnippet: {
    typescript: string;
    python: string;
    elizaos: string;
  };
}

export default function WorkflowsPage() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplate | null>(null);
  const [codeLang, setCodeLang] = useState<"typescript" | "python" | "elizaos">("typescript");
  const [copiedCode, setCopiedCode] = useState(false);
  const [testingWorkflow, setTestingWorkflow] = useState(false);
  const [testOutput, setTestOutput] = useState<{ receipt?: string; logs?: Array<{ time: string; step: string; message: string }> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadTemplates() {
      try {
        const res = await fetch("/api/workflows");
        const data = await res.json();
        if (!cancelled && data.templates) {
          setTemplates(data.templates);
          setSelectedTemplate(data.templates[0]);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    loadTemplates();

    try {
      sdk.actions.ready();
    } catch {}

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopyCode = (snippet: string) => {
    navigator.clipboard?.writeText(snippet);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleTestRun = async (templateId: string) => {
    setTestingWorkflow(true);
    setTestOutput(null);

    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowId: templateId }),
      });
      const data = await res.json();
      setTestOutput({
        receipt: data.executionReceipt,
        logs: data.logs,
      });
    } catch {
      setTestOutput({
        logs: [{ time: "ERR", step: "ERROR", message: "Workflow test execution failed." }],
      });
    } finally {
      setTestingWorkflow(false);
    }
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
          Agentic Automation Cloud • Multi-Step Pipelines
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
          Autonomous Agent Recipes & Workflows
        </h1>
        <p style={{ color: "#94a3b8", fontSize: "1.05rem", maxWidth: 680, margin: "0 auto 1.5rem" }}>
          Production-grade multi-step pipelines combining honeypot safety checks, cross-DEX arbitrage, and EIP-3009 gasless swaps into single atomic workflows.
        </p>

        <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
          <Link
            href="/terminal"
            style={{
              padding: "0.6rem 1.25rem",
              borderRadius: 8,
              backgroundColor: "#0052ff",
              color: "#fff",
              fontWeight: 700,
              fontSize: "0.9rem",
              textDecoration: "none",
            }}
          >
            💻 Open Agent Terminal ➔
          </Link>
          <Link
            href="/leaderboard"
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
            🏆 Leaderboard
          </Link>
        </div>
      </div>

      {/* Grid: Workflow List on Left, Detail & Code on Right */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "4rem 0", color: "#64748b" }}>Loading workflow templates...</div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))",
            gap: "1.5rem",
          }}
        >
          {/* Left Column: Workflow Selector */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "#94a3b8", textTransform: "uppercase" }}>
              Curated Agent Recipes ({templates.length})
            </div>

            {templates.map((wf) => {
              const isSelected = selectedTemplate?.id === wf.id;
              return (
                <div
                  key={wf.id}
                  onClick={() => {
                    setSelectedTemplate(wf);
                    setTestOutput(null);
                  }}
                  style={{
                    backgroundColor: isSelected ? "rgba(0, 82, 255, 0.12)" : "rgba(15, 23, 42, 0.6)",
                    border: isSelected ? "1px solid rgba(0, 82, 255, 0.6)" : "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 12,
                    padding: "1.1rem 1.25rem",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
                    <div style={{ fontWeight: 800, color: isSelected ? "#60a5fa" : "#f8fafc", fontSize: "1.05rem" }}>
                      {wf.name}
                    </div>
                    <span
                      style={{
                        fontSize: "0.68rem",
                        fontWeight: 800,
                        padding: "0.15rem 0.45rem",
                        borderRadius: 4,
                        backgroundColor: isSelected ? "rgba(0, 82, 255, 0.25)" : "rgba(255,255,255,0.06)",
                        color: isSelected ? "#93c5fd" : "#94a3b8",
                      }}
                    >
                      {wf.badge}
                    </span>
                  </div>
                  <p style={{ color: "#94a3b8", fontSize: "0.82rem", margin: "0 0 0.75rem", lineHeight: 1.45 }}>
                    {wf.description}
                  </p>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#64748b" }}>
                    <span>Pipeline Cost: <strong style={{ color: "#10b981" }}>${wf.totalCostUsdc} USDC</strong></span>
                    <span>Latency: <strong style={{ color: "#cbd5e1" }}>~{wf.estExecutionTimeMs}ms</strong></span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right Column: Workflow Steps & Code Exporter */}
          {selectedTemplate && (
            <div
              style={{
                backgroundColor: "rgba(11, 15, 25, 0.9)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 14,
                padding: "1.5rem",
                display: "flex",
                flexDirection: "column",
                gap: "1.25rem",
              }}
            >
              {/* Header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.75rem" }}>
                <div>
                  <h2 style={{ fontSize: "1.35rem", fontWeight: 800, margin: "0 0 0.35rem", color: "#f8fafc" }}>
                    {selectedTemplate.name}
                  </h2>
                  <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
                    {selectedTemplate.steps.length} atomic stages • Total Cost: ${selectedTemplate.totalCostUsdc} USDC
                  </div>
                </div>

                <button
                  onClick={() => handleTestRun(selectedTemplate.id)}
                  disabled={testingWorkflow}
                  style={{
                    padding: "0.5rem 1rem",
                    borderRadius: 8,
                    backgroundColor: "#10b981",
                    color: "#022c22",
                    border: "none",
                    fontWeight: 800,
                    fontSize: "0.85rem",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                  }}
                >
                  {testingWorkflow ? "Running..." : "▶ Test Run Pipeline"}
                </button>
              </div>

              {/* Steps Visual Chain */}
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "#64748b", textTransform: "uppercase" }}>
                  Execution Sequence:
                </div>
                {selectedTemplate.steps.map((st, idx) => (
                  <div
                    key={idx}
                    style={{
                      backgroundColor: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      borderRadius: 8,
                      padding: "0.75rem 1rem",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "0.75rem",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, fontSize: "0.9rem", color: "#f1f5f9" }}>{st.name}</div>
                      <div style={{ fontSize: "0.78rem", color: "#94a3b8", marginTop: "0.15rem" }}>{st.description}</div>
                      {st.condition && (
                        <div style={{ fontSize: "0.72rem", color: "#38bdf8", marginTop: "0.25rem", fontFamily: "monospace" }}>
                          Guard Rule: {st.condition}
                        </div>
                      )}
                    </div>
                    <div style={{ fontWeight: 800, color: "#10b981", fontSize: "0.85rem", whiteSpace: "nowrap" }}>
                      ${st.costUsdc}
                    </div>
                  </div>
                ))}
              </div>

              {/* Test Run Output */}
              {testOutput && (
                <div
                  style={{
                    backgroundColor: "#030712",
                    border: "1px solid rgba(16, 185, 129, 0.3)",
                    borderRadius: 8,
                    padding: "0.85rem 1rem",
                    fontSize: "0.78rem",
                    fontFamily: "monospace",
                  }}
                >
                  <div style={{ color: "#10b981", fontWeight: 800, marginBottom: "0.4rem" }}>
                    ✓ PIPELINE VERIFIED • Receipt: {testOutput.receipt}
                  </div>
                  {testOutput.logs?.map((l, i) => (
                    <div key={i} style={{ color: "#94a3b8", lineHeight: 1.4 }}>
                      <span style={{ color: "#64748b" }}>[{l.time}]</span> {l.message}
                    </div>
                  ))}
                </div>
              )}

              {/* Ready-to-Run Code Exporter */}
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", gap: "0.35rem" }}>
                    {(["typescript", "python", "elizaos"] as const).map((lang) => (
                      <button
                        key={lang}
                        onClick={() => setCodeLang(lang)}
                        style={{
                          padding: "0.25rem 0.65rem",
                          borderRadius: 6,
                          border: "none",
                          backgroundColor: codeLang === lang ? "rgba(0, 82, 255, 0.25)" : "transparent",
                          color: codeLang === lang ? "#60a5fa" : "#64748b",
                          fontWeight: 700,
                          fontSize: "0.75rem",
                          cursor: "pointer",
                          textTransform: "capitalize",
                        }}
                      >
                        {lang}
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={() => handleCopyCode(selectedTemplate.codeSnippet[codeLang])}
                    style={{
                      padding: "0.25rem 0.65rem",
                      borderRadius: 6,
                      border: "1px solid rgba(255,255,255,0.15)",
                      backgroundColor: "rgba(255,255,255,0.05)",
                      color: copiedCode ? "#10b981" : "#94a3b8",
                      fontSize: "0.75rem",
                      cursor: "pointer",
                    }}
                  >
                    {copiedCode ? "✓ Copied" : "Copy Code"}
                  </button>
                </div>

                <pre
                  style={{
                    backgroundColor: "#030712",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 8,
                    padding: "0.85rem 1rem",
                    overflowX: "auto",
                    color: "#7dd3fc",
                    fontSize: "0.78rem",
                    lineHeight: 1.5,
                    margin: 0,
                  }}
                >
                  <code>{selectedTemplate.codeSnippet[codeLang]}</code>
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
