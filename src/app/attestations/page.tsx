import Link from "next/link";
import { SAMPLE_ATTESTATIONS } from "@/app/api/attestations/route";

export const metadata = {
  title: "Base EAS Attestations & Security Oracle — x402 Bazaar",
  description: "Public verifiable onchain security attestations written directly to Ethereum Attestation Service (EAS) on Base by x402 Bazaar Sentinel.",
};

const BASE_EAS_CONTRACT = "0x4200000000000000000000000000000000000021";
const BASE_SCHEMA_REGISTRY = "0x4200000000000000000000000000000000000020";
const BUILDER_CODE = "bc_pa0gqlv1";

export default function AttestationsPage() {
  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "1.5rem 1rem 4rem" }}>
      {/* Top Banner */}
      <div style={{ marginBottom: "2rem" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", padding: "0.25rem 0.75rem", borderRadius: 999, backgroundColor: "rgba(0, 82, 255, 0.12)", border: "1px solid rgba(0, 82, 255, 0.25)", color: "#60a5fa", fontSize: "0.75rem", fontWeight: 700, marginBottom: "0.75rem" }}>
          <span>📜 BASE PREDEPLOY ATTESTATIONS</span>
          <span>•</span>
          <code style={{ color: "#38bdf8" }}>bc_pa0gqlv1</code>
        </div>
        <h1 style={{ fontSize: "2rem", fontWeight: 900, letterSpacing: "-0.03em", color: "#f8fafc", margin: "0 0 0.5rem" }}>
          Onchain Security &amp; EAS Attestation Oracle
        </h1>
        <p style={{ color: "#94a3b8", fontSize: "0.95rem", maxWidth: 760, lineHeight: 1.6, margin: 0 }}>
          Every honeypot, scam, and fraudulent contract detected by x402 Bazaar Sentinel is permanently registered onto Base via the <strong>Ethereum Attestation Service (EAS)</strong>. A tamper-proof public good for autonomous AI agents and institutional traders.
        </p>
      </div>

      {/* Contract & Schema Telemetry Bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
        <div style={{ backgroundColor: "#080c18", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: "1.25rem" }}>
          <span style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#64748b", fontWeight: 700, display: "block", marginBottom: "0.35rem" }}>
            Base EAS Predeploy
          </span>
          <code style={{ fontSize: "0.85rem", color: "#38bdf8", fontWeight: 700, display: "block" }}>
            {BASE_EAS_CONTRACT.slice(0, 10)}...{BASE_EAS_CONTRACT.slice(-6)}
          </code>
          <a
            href={`https://basescan.org/address/${BASE_EAS_CONTRACT}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: "0.75rem", color: "#60a5fa", textDecoration: "underline", marginTop: "0.35rem", display: "inline-block" }}
          >
            View on Basescan ↗
          </a>
        </div>

        <div style={{ backgroundColor: "#080c18", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: "1.25rem" }}>
          <span style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#64748b", fontWeight: 700, display: "block", marginBottom: "0.35rem" }}>
            Schema Registry
          </span>
          <code style={{ fontSize: "0.85rem", color: "#f8fafc", fontWeight: 700, display: "block" }}>
            {BASE_SCHEMA_REGISTRY.slice(0, 10)}...{BASE_SCHEMA_REGISTRY.slice(-6)}
          </code>
          <span style={{ fontSize: "0.75rem", color: "#10b981", display: "inline-block", marginTop: "0.35rem" }}>
            ● Base Native Predeploy
          </span>
        </div>

        <div style={{ backgroundColor: "#080c18", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: "1.25rem" }}>
          <span style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#64748b", fontWeight: 700, display: "block", marginBottom: "0.35rem" }}>
            Attestation Schema
          </span>
          <span style={{ fontSize: "0.78rem", color: "#cbd5e1", fontFamily: "monospace", display: "block", wordBreak: "break-all" }}>
            address token, string symbol, string scamType, string reasons
          </span>
        </div>

        <div style={{ backgroundColor: "#080c18", border: "1px solid rgba(0, 82, 255, 0.2)", borderRadius: 14, padding: "1.25rem" }}>
          <span style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#60a5fa", fontWeight: 700, display: "block", marginBottom: "0.35rem" }}>
            Base Builder Code
          </span>
          <strong style={{ fontSize: "1.25rem", color: "#ffffff", display: "block" }}>
            {BUILDER_CODE}
          </strong>
          <span style={{ fontSize: "0.75rem", color: "#94a3b8", display: "inline-block", marginTop: "0.15rem" }}>
            ERC-8021 Attribution Active
          </span>
        </div>
      </div>

      {/* Attestations Table */}
      <div style={{ backgroundColor: "#080c18", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, overflow: "hidden", marginBottom: "2.5rem" }}>
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#10b981", boxShadow: "0 0 8px #10b981" }} />
            <strong style={{ fontSize: "0.9rem", color: "#f8fafc" }}>
              Verifiable Onchain Security Attestations
            </strong>
            <span style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem", borderRadius: 6, backgroundColor: "rgba(255,255,255,0.06)", color: "#94a3b8" }}>
              {SAMPLE_ATTESTATIONS.length} Records
            </span>
          </div>

          <Link
            href="/terminal"
            style={{ fontSize: "0.75rem", color: "#38bdf8", textDecoration: "none", display: "flex", alignItems: "center", gap: "0.25rem" }}
          >
            <span>Launch Sentinel Terminal →</span>
          </Link>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.82rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", backgroundColor: "rgba(255,255,255,0.02)", color: "#64748b" }}>
                <th style={{ padding: "0.85rem 1.25rem" }}>Token / Recipient</th>
                <th style={{ padding: "0.85rem 1rem" }}>Symbol</th>
                <th style={{ padding: "0.85rem 1rem" }}>Verdict / Type</th>
                <th style={{ padding: "0.85rem 1rem" }}>Reasoning</th>
                <th style={{ padding: "0.85rem 1.25rem", textAlign: "right" }}>EAS Attestation</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_ATTESTATIONS.map((record) => (
                <tr
                  key={record.uid}
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                >
                  <td style={{ padding: "1rem 1.25rem", fontFamily: "monospace" }}>
                    <span style={{ color: "#f8fafc", fontWeight: 600 }}>
                      {record.recipient.slice(0, 6)}...{record.recipient.slice(-4)}
                    </span>
                  </td>
                  <td style={{ padding: "1rem 1rem", fontWeight: 700, color: "#38bdf8" }}>
                    {record.data.symbol}
                  </td>
                  <td style={{ padding: "1rem 1rem" }}>
                    <span style={{ padding: "0.2rem 0.5rem", borderRadius: 4, fontSize: "0.72rem", fontWeight: 700, backgroundColor: "rgba(239, 68, 68, 0.15)", color: "#f87171", border: "1px solid rgba(239, 68, 68, 0.25)" }}>
                      {record.data.scamType}
                    </span>
                  </td>
                  <td style={{ padding: "1rem 1rem", color: "#94a3b8", maxWidth: 320, lineHeight: 1.4 }}>
                    {record.data.reasons}
                  </td>
                  <td style={{ padding: "1rem 1.25rem", textAlign: "right", fontFamily: "monospace" }}>
                    <a
                      href={record.easScanUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ padding: "0.3rem 0.65rem", borderRadius: 6, backgroundColor: "rgba(0, 82, 255, 0.15)", border: "1px solid rgba(0, 82, 255, 0.3)", color: "#60a5fa", textDecoration: "none", fontSize: "0.75rem", fontWeight: 600, display: "inline-block" }}
                    >
                      View on EAS Scan ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Developer Integration Code Blocks */}
      <div style={{ backgroundColor: "#060912", border: "1px solid rgba(0, 82, 255, 0.2)", borderRadius: 16, padding: "1.5rem" }}>
        <h3 style={{ fontSize: "1rem", fontWeight: 800, color: "#f8fafc", margin: "0 0 0.5rem" }}>
          🤖 Verify EAS Attestations in Your Agent
        </h3>
        <p style={{ color: "#94a3b8", fontSize: "0.85rem", margin: "0 0 1rem" }}>
          Query x402 Bazaar&apos;s onchain EAS attestations directly in Python or TypeScript before trading or executing autonomous swaps on Base.
        </p>

        <pre style={{ backgroundColor: "#030408", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: "1rem", color: "#38bdf8", fontSize: "0.8rem", fontFamily: "monospace", overflowX: "auto" }}>
{`# Python (LangChain / CrewAI / AutoGen)
import requests

res = requests.get("https://402.com.tr/api/attestations?token=0xDEADBEEF0000000000000000000000000000CAFE")
data = res.json()
if data["totalAttestations"] > 0:
    print(f"ALERT: Token flagged on Base EAS: {data['attestations'][0]['data']['scamType']}")
    # Block trade execution automatically`}
        </pre>
      </div>
    </div>
  );
}
