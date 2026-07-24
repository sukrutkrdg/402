/**
 * pre-trade-gate — the one call an agent makes before touching a Base token.
 *
 * Composes the proven pre-trade checks (risk + sellability + route + deployer)
 * into a single GO / HOLD / STOP verdict with the same auditable receipt shape as
 * token-risk. Answers "which of the 70 tools do I call first?" — this one.
 * Reuses existing handlers, so no new upstreams.
 */

import "server-only";
import { decisionReceipt } from "./envelope";
import { tokenRisk } from "./onchain";
import { sellability } from "./sellability";
import { swapRoute } from "./swap-route";
import { deployerReputation } from "./deployer-rep";

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export async function preTradeGate(params: Record<string, string>) {
  const address = (params.address || params.tokenOut || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Provide a valid 0x… token contract address");
  const amountUsd = params.amountUsd || params.size || "1000";
  const tradeSizeUsd = Number(amountUsd);
  if (!Number.isFinite(tradeSizeUsd) || tradeSizeUsd <= 0) throw new Error("amountUsd must be a positive number");

  // Run the four checks; tolerate individual upstream failures (never block the
  // whole gate because one provider hiccuped — surface what we could read).
  const [riskR, sellR, routeR, deployR] = await Promise.allSettled([
    tokenRisk({ address }),
    sellability({ address }),
    swapRoute({ tokenOut: address, amountUsd }),
    deployerReputation({ address }),
  ]);

  const risk = riskR.status === "fulfilled" ? (riskR.value as Record<string, unknown>) : null;
  const sell = sellR.status === "fulfilled" ? (sellR.value as Record<string, unknown>) : null;
  const route = routeR.status === "fulfilled" ? (routeR.value as Record<string, unknown>) : null;
  const deploy = deployR.status === "fulfilled" ? (deployR.value as Record<string, unknown>) : null;

  const sec = (risk?.security ?? {}) as { isHoneypot?: boolean; sellTaxPct?: number | null };
  const honeypot = Boolean(sec.isHoneypot) || (sell?.canSell === false);
  const sellTax = num(sec.sellTaxPct) ?? num(sell?.sellTaxPct);
  const riskScore = num(risk?.riskScore);
  const impact = num(route?.estPriceImpactPct);
  const deployRep = String(deploy?.reputation ?? "");

  // A GO must mean "everything was CHECKED and clean" — a failed upstream is
  // UNKNOWN, not safe. Any missing check (or a token-risk read that ran without
  // its honeypot source, so isHoneypot could be silently absent) degrades the
  // gate: the best it can then say is HOLD.
  const riskSources = Array.isArray(risk?.sources) ? (risk!.sources as unknown[]).map(String) : null;
  const honeypotChecked = riskSources ? riskSources.some((s) => /goplus/i.test(s)) : sec.isHoneypot !== undefined;
  const unavailable: string[] = [];
  if (!risk) unavailable.push("token-risk");
  else if (!honeypotChecked) unavailable.push("token-risk honeypot source (GoPlus)");
  if (!sell) unavailable.push("sellability");
  if (!route) unavailable.push("swap-route");
  if (!deploy) unavailable.push("deployer-rep");
  const degraded = unavailable.length > 0;

  const observedRisks: string[] = [];
  if (honeypot) observedRisks.push("honeypot / cannot sell");
  if (sellTax !== null && sellTax >= 20) observedRisks.push(`high sell tax ${sellTax}%`);
  if (riskScore !== null && riskScore >= 70) observedRisks.push("high token-risk score");
  if (impact !== null && impact >= 10) observedRisks.push(`price impact ${impact}% at this size`);
  if (/high[_-]?risk|scam|serial/.test(deployRep)) observedRisks.push(`deployer: ${deployRep}`);
  if ((risk?.ownership as { renounced?: boolean } | undefined)?.renounced === false) observedRisks.push("ownership not renounced");
  if (degraded) observedRisks.push(`unverified: ${unavailable.join(", ")}`);

  // Decision: any terminal flag → STOP; material risks OR an unverified check →
  // HOLD; GO only when every check ran and came back clean. A high_risk deployer
  // (serial rugger profile) is terminal, not merely cautionary.
  const stop = honeypot || (sellTax !== null && sellTax >= 50) || (riskScore !== null && riskScore >= 80) || /high[_-]?risk|scam/.test(deployRep);
  const hold = observedRisks.length > 0 || degraded;
  const decision = stop ? "STOP" : hold ? "HOLD" : "GO";

  return {
    address,
    tradeSizeUsd,
    decision, // GO | HOLD | STOP
    ...(degraded ? { degraded: true, unverifiedChecks: unavailable } : {}),
    receipt: {
      checked: address,
      at: new Date().toISOString(),
      endpoint: "pre-trade-gate",
      decision,
      ...decisionReceipt({
        endpoint: "pre-trade-gate",
        params: { address },
        degraded,
        missing: degraded ? unavailable : [],
      }),
      observedRisks,
      checks: {
        tokenRisk: risk ? { score: riskScore, level: risk.riskLevel } : "unavailable",
        sellable: sell ? { canSell: sell.canSell, sellTaxPct: sellTax } : "unavailable",
        route: route ? { estPriceImpactPct: impact, verdict: route.verdict } : "unavailable",
        deployer: deploy ? { reputation: deploy.reputation, score: deploy.reputationScore } : "unavailable",
      },
      wouldChangeCall: stop
        ? "Nothing while a terminal flag (honeypot / extreme tax / scam deployer) stands."
        : "Renounce, tax drop, deeper liquidity, or a cleaner deployer history — re-check before sizing up.",
      recheckAfter: new Date(Date.now() + (stop ? 3600_000 : hold ? 6 * 3600_000 : 24 * 3600_000)).toISOString(),
    },
    recommendation:
      decision === "STOP"
        ? "Do not trade — a terminal safety flag is set."
        : decision === "HOLD"
          ? degraded && observedRisks.length === 1 /* the only "risk" is the unverified entry */
            ? "Do not treat as clean — one or more checks could not be verified (provider down). Re-check before trading."
            : "Tradeable with caution — size down and mind the risks above; some checks may be provider-limited."
          : "No blocking flags across risk, sellability, routing and deployer — all four checks ran. Proceed within normal size.",
    note: "Single pre-trade gate = token-risk + sellability + swap-route + deployer-rep, collapsed to one verdict. GO is only returned when every check ran clean; an unavailable provider degrades the answer to HOLD, never GO. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
