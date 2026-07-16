/**
 * Portfolio Risk Scan — audit a whole wallet in one call.
 *
 * Pulls a wallet's holdings, then runs a token-risk check on each and flags which
 * positions are honeypots / high-risk / illiquid, plus the USD sitting in risky
 * tokens. One call tells an agent "which of the things you already hold could
 * hurt you" — the audit no single endpoint gives.
 *
 * Metered upstream (Alchemy for holdings) → registered paid-only.
 */

import "server-only";
import { walletPortfolio } from "./alchemy";
import { tokenRisk } from "./onchain";
import type { TokenRiskResult } from "./envelope";

const MAX_SCAN = 8; // bound cost + latency

interface Holding {
  symbol?: string | null;
  address?: string;
  usdValue?: number | null;
}
// tokenRisk() exposes the score/level at the TOP level and the honeypot/tax
// fields nested under `security` — the shared TokenRiskResult encodes both.
type RiskShape = TokenRiskResult;

export async function portfolioScan(params: Record<string, string>) {
  const port = (await walletPortfolio(params)) as {
    address?: string;
    totalUsd?: number;
    tokenCount?: number;
    holdings?: Holding[];
  };
  const holdings = (port.holdings ?? []).filter((h) => h.address);
  const toScan = holdings.slice(0, MAX_SCAN);

  const risks = await Promise.allSettled(
    toScan.map((h) => tokenRisk({ address: h.address as string })),
  );

  const scanned = toScan.map((h, i) => {
    const r = risks[i];
    const risk = (r.status === "fulfilled" ? r.value : null) as RiskShape | null;
    const flags = risk?.flags ?? [];
    const sec = risk?.security;
    const honeypot = Boolean(sec?.isHoneypot) || flags.includes("honeypot");
    const sellTax = typeof sec?.sellTaxPct === "number" ? sec.sellTaxPct : null;
    const level = honeypot ? "critical" : (risk?.riskLevel as string) ?? "unknown";
    return {
      symbol: h.symbol ?? null,
      address: h.address,
      usdValue: h.usdValue ?? null,
      riskScore: typeof risk?.riskScore === "number" ? risk.riskScore : null,
      riskLevel: level, // low | medium | high | critical | unknown
      honeypot,
      sellTaxPct: sellTax,
      flags,
    };
  });

  const risky = scanned.filter((s) => s.honeypot || s.riskLevel === "high" || s.riskLevel === "critical");
  const usdInRisky = +risky.reduce((s, r) => s + (r.usdValue ?? 0), 0).toFixed(2);
  const honeypots = scanned.filter((s) => s.honeypot);

  const level = honeypots.length > 0 ? "critical" : risky.length > 0 ? "high" : "low";

  return {
    address: port.address ?? params.address,
    totalUsd: port.totalUsd ?? null,
    holdingsScanned: scanned.length,
    holdingsTotal: port.tokenCount ?? holdings.length,
    riskyCount: risky.length,
    honeypotCount: honeypots.length,
    usdInRiskyTokens: usdInRisky,
    portfolioRisk: level, // low | high | critical
    holdings: scanned.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0)),
    worstOffenders: [...risky].sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0)).slice(0, 5),
    recommendation:
      honeypots.length > 0
        ? `${honeypots.length} holding(s) look like honeypots — you may not be able to sell them. Investigate before assuming that USD is real.`
        : risky.length > 0
          ? `${risky.length} holding(s) are high-risk ($${usdInRisky} exposure). Review before adding.`
          : "No high-risk holdings detected among the scanned positions.",
    note: `Scanned the top ${MAX_SCAN} holdings by USD value via a token-risk check each. Not financial advice.`,
    checkedAt: new Date().toISOString(),
  };
}
