/**
 * pre-trade-bundle — five already-hardened pre-trade checks in one call.
 *
 *   pre-trade-gate      token-risk + sellability + swap-route + deployer-rep
 *   b20-gate            protocol-level seize / freeze / pause (B20 tokens only)
 *   owner-powers        what the owner can still switch on after you buy
 *   dump-risk           can the pool absorb the largest live holders exiting
 *   clanker-token-audit launch provenance — informational, never gates
 *
 * The version this replaces answered EXECUTE/100 when every sub-check had
 * failed, because it read fields its dependencies never return and coerced
 * missing values into clean ones. The rules here exist to make that impossible:
 *
 *   - Each dependency's output is read through its own return type (see the
 *     `*Out` aliases), so a field name that does not exist fails to compile.
 *   - A check is "clean" only on a positive clean answer. A thrown check, a
 *     degraded one, an unknown verdict or a missing field is UNVERIFIED, and
 *     any unverified gating check rules out GO.
 *   - b20-gate's isB20:false is "not applicable", never a pass and never a
 *     failure. A b20-gate that could not run is unverified, because we then do
 *     not know whether the token is a B20 at all.
 *   - clanker-token-audit cannot raise or lower the decision. not_clanker is a
 *     statement about origin; a verified launch with locked liquidity is noted.
 *
 * Billing follows pre-trade-gate: if the gate itself could not run the call
 * throws (not charged); if any gating check is unverified the receipt is a
 * refusal (refundable — 502 on x402, auto-refund on credits). Only a complete
 * read is billed.
 */

import "server-only";
import { getAddress } from "viem";
import { decisionReceipt } from "./envelope";
import { preTradeGate } from "./gate";
import { b20Gate } from "./b20-safety";
import { ownerPowers } from "./owner-powers";
import { dumpRiskCore, usdStablecoin, EXIT_TRAP_MIN_DAYS } from "./dump-risk";
import { findStock } from "./tokenized-stocks";
import { ESTABLISHED_LIQUIDITY_USD } from "./established";
import { clankerTokenAudit } from "./clanker-audit";
import { goPlusSecurity, dexTokenPairs } from "./upstream-cache";

export type GateOut = Awaited<ReturnType<typeof preTradeGate>>;
export type B20GateOut = Awaited<ReturnType<typeof b20Gate>>;
export type OwnerPowersOut = Awaited<ReturnType<typeof ownerPowers>>;
export type DumpRiskOut = Awaited<ReturnType<typeof dumpRiskCore>>;
export type ClankerOut = Awaited<ReturnType<typeof clankerTokenAudit>>;

const ENDPOINT = "pre-trade-bundle";

/** Impact the recommended size is held to, using dump-risk's constant-product model. */
const MAX_IMPACT = 0.02;

type Status = "clean" | "risk" | "stop" | "not_applicable" | "unverified" | "info";

export interface CheckView {
  /** clean | risk | stop | not_applicable | unverified (gating) — info for clanker */
  status: Status;
  /** The dependency's own decision / verdict string, as returned. */
  decision: string | null;
  /** What the check actually saw — only fields the dependency returned. */
  saw: Record<string, unknown>;
  /** Why this status was assigned. */
  reason: string;
}

export interface Unverified {
  check: string;
  reason: string;
  /** true → this blocks GO. false → informational (clanker-token-audit). */
  gating: boolean;
}

const errText = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)).slice(0, 200) : "";

// ---- per-check interpretation (exported for tests) ----

export function viewGate(g: GateOut): CheckView {
  const saw = {
    decision: g.decision,
    tradeSizeUsd: g.tradeSizeUsd,
    observedRisks: g.receipt.observedRisks,
    checks: g.receipt.checks,
    ...(g.unverifiedChecks ? { unverifiedChecks: g.unverifiedChecks } : {}),
  };
  if (g.decision === "STOP") return { status: "stop", decision: g.decision, saw, reason: "pre-trade-gate raised a terminal flag (honeypot, extreme tax, very high risk score or scam deployer)" };
  if (g.degraded === true) {
    return { status: "unverified", decision: g.decision, saw, reason: `pre-trade-gate could not verify: ${(g.unverifiedChecks ?? []).join(", ") || "one or more checks"}` };
  }
  if (g.decision === "HOLD") return { status: "risk", decision: g.decision, saw, reason: `pre-trade-gate saw: ${g.receipt.observedRisks.join("; ")}` };
  if (g.decision === "GO") {
    const isStock = "assetType" in g && g.assetType === "tokenized-stock";
    return { status: "clean", decision: g.decision, saw, reason: isStock ? "tokenized-stock checks (transfer policy, premium vs reference, route) ran and came back clean" : "all four gate checks ran and came back clean" };
  }
  return { status: "unverified", decision: String(g.decision), saw, reason: "pre-trade-gate returned no recognisable decision" };
}

export function viewB20(b: B20GateOut): CheckView {
  if (b.isB20 === false) {
    return { status: "not_applicable", decision: b.decision, saw: { isB20: false }, reason: "not a B20 token (factory/precompile read) — B20 seize/freeze powers do not apply" };
  }
  if ("degraded" in b && b.degraded === true) {
    return { status: "unverified", decision: b.decision, saw: { isB20: true, symbol: b.symbol, variant: b.variant }, reason: "a seize/freeze-critical B20 precompile read failed — B20 powers could not be confirmed" };
  }
  if (!("powers" in b)) {
    return { status: "unverified", decision: b.decision, saw: { isB20: b.isB20 }, reason: "b20-gate returned no power read" };
  }
  const saw = { isB20: true, symbol: b.symbol, variant: b.variant, powers: b.powers, observedRisks: b.observedRisks };
  if (b.decision === "STOP") return { status: "stop", decision: b.decision, saw, reason: `B20 terminal power: ${b.observedRisks.join("; ")}` };
  if (b.decision === "HOLD") return { status: "risk", decision: b.decision, saw, reason: `B20 issuer controls: ${b.observedRisks.join("; ")}` };
  if (b.decision === "GO" && "regulatedIssuer" in b && b.regulatedIssuer) {
    return { status: "clean", decision: b.decision, saw: { ...saw, issuerControls: b.issuerControls }, reason: `recognised regulated issuer — its powers are context: ${(b.issuerControls ?? []).join("; ")}` };
  }
  if (b.decision === "GO") return { status: "clean", decision: b.decision, saw, reason: "B20 with no high-control powers" };
  return { status: "unverified", decision: String(b.decision), saw, reason: "b20-gate returned no recognisable decision" };
}

/**
 * not_applicable for a roster stock — but only once b20-gate has confirmed the
 * chain-anchored regulated issuer; a roster hit alone is not enough to waive a check.
 */
function stockNotApplicable(b20R: PromiseSettledResult<B20GateOut>, sym: string, why: string): CheckView {
  const ok = b20R.status === "fulfilled" && "regulatedIssuer" in b20R.value && Boolean(b20R.value.regulatedIssuer);
  return ok
    ? { status: "not_applicable", decision: "not_applicable", saw: { tokenizedStock: sym }, reason: `${sym} is a Coinbase tokenized stock — ${why}` }
    : { status: "unverified", decision: null, saw: { tokenizedStock: sym }, reason: `${sym} is on the stock roster but b20-gate did not confirm its regulated issuer` };
}

export function viewOwner(o: OwnerPowersOut, established = false, ownerlessOnChain = false): CheckView {
  const saw = {
    verdict: o.verdict,
    ownerAddress: o.ownerAddress,
    ownershipRenounced: o.ownershipRenounced,
    renounceIsReal: o.renounceIsReal,
    isOpenSource: o.isOpenSource,
    severity: o.severity,
    powers: o.powers.map((p) => `${p.flag} (${p.severity})`),
  };
  if (o.verdict === "owner_controlled_danger") {
    return { status: "stop", decision: o.verdict, saw, reason: `owner holds a critical power: ${o.powers.filter((p) => p.severity === "critical").map((p) => p.flag).join(", ")}` };
  }
  // An established token's issuer keeping mint/pause/blacklist (Circle on USDC)
  // is how it is run, the same demotion token-risk 1.3 applies. weaponizable
  // (a trap power such as a raisable sell tax) is never demoted.
  if (o.verdict === "limited_controls" && established) {
    return { status: "clean", decision: o.verdict, saw, reason: `issuer controls on an established token, reported as context: ${o.powers.map((p) => p.flag).join(", ") || "ownership kept"}` };
  }
  if (o.verdict === "weaponizable" || o.verdict === "limited_controls") {
    return { status: "risk", decision: o.verdict, saw, reason: `mutable owner controls remain: ${o.powers.map((p) => p.flag).join(", ") || "ownership not renounced"}` };
  }
  if (o.verdict === "renounced_clean") {
    // owner-powers reads an absent owner_address as "" (renounced) and an absent
    // is_open_source as null. A clean verdict built on either absence is a
    // verdict on fields GoPlus did not send.
    if (o.ownerAddress === null || o.ownerAddress === undefined || o.isOpenSource === null) {
      // An absent owner field is only "no owner" when the chain agrees: the
      // token has no owner()/getOwner() (WETH is a predeploy with none), and it
      // is established. GoPlus alone omitting the field proves nothing.
      if (established && ownerlessOnChain) {
        return { status: "clean", decision: o.verdict, saw, reason: "no owner: the contract has no owner()/getOwner() on chain, and the token is established" };
      }
      return { status: "unverified", decision: o.verdict, saw, reason: "GoPlus row lacked owner_address or is_open_source — 'renounced, no powers' was not actually observed" };
    }
    return { status: "clean", decision: o.verdict, saw, reason: "ownership renounced with no reclaim path and no mutable trap powers" };
  }
  return { status: "unverified", decision: String(o.verdict), saw, reason: "owner-powers returned no recognisable verdict" };
}

export function viewDump(d: DumpRiskOut): CheckView {
  const saw = {
    verdict: d.verdict,
    aggregateLiquidityUsd: d.aggregateLiquidityUsd,
    poolsCounted: d.poolsCounted,
    marketCapUsd: d.marketCapUsd,
    topDumpableHolderPct: d.topDumpableHolder?.percentOfSupply ?? null,
    topDumpableHolderLabel: d.topDumpableHolder?.label ?? null,
    topHolderDumpImpactPct: d.topHolderDumpImpactPct,
    top3DumpImpactPct: d.top3DumpImpactPct,
    topHolderExitDays: d.topHolderExitDays,
    excludedAsNonDumpable: d.excludedAsNonDumpable.map((h) => `${h.label} ${h.percent}%`),
    cexConcentrationPct: d.cexConcentrationPct,
  };
  const who = d.topDumpableHolder ? ` (${d.topDumpableHolder.percentOfSupply}%, ${d.topDumpableHolder.label})` : "";
  switch (d.verdict) {
    // HOLD, not STOP: the evidence is "DexScreener indexes no Base pool", which
    // can also mean a pool it does not track (seen on a live Clanker v4 token
    // whose locked v4 position exists onchain). No exit is demonstrated, so it
    // is never GO; STOP is kept for terminal onchain evidence.
    case "no_liquidity":
      return { status: "risk", decision: d.verdict, saw, reason: "no Base DEX liquidity indexed for this token (DexScreener) — an exit is not demonstrated" };
    case "fragile":
    case "absorbable":
      // A bag the market turns over in under EXIT_TRAP_MIN_DAYS, on a token with
      // real liquidity, is an exit that is absorbed when spread out. WETH read
      // HOLD here because its largest holder selling everything AT ONCE would
      // move price 12% — a twentieth of a day of its volume.
      if (
        d.topHolderExitDays != null &&
        d.topHolderExitDays < EXIT_TRAP_MIN_DAYS &&
        d.aggregateLiquidityUsd >= ESTABLISHED_LIQUIDITY_USD
      ) {
        return {
          status: "clean",
          decision: d.verdict,
          saw,
          reason: `largest live holder${who} is ~${d.topHolderExitDays} day(s) of this token's Base DEX volume over $${d.aggregateLiquidityUsd.toLocaleString("en-US")} of liquidity — absorbed unless dumped at once (one-shot impact ~${d.topHolderDumpImpactPct}%)`,
        };
      }
    // falls through
    case "exit_trap":
      return { status: "risk", decision: d.verdict, saw, reason: `largest live holder${who} exiting would move price ~${d.topHolderDumpImpactPct}% against $${d.aggregateLiquidityUsd.toLocaleString("en-US")} of liquidity` };
    case "resilient":
      return { status: "clean", decision: d.verdict, saw, reason: `largest live holder${who} exiting moves price ~${d.topHolderDumpImpactPct}% — the pools absorb it` };
    case "unknown":
      return { status: "unverified", decision: d.verdict, saw, reason: "no market cap available to value the holder bags — dump impact could not be quantified" };
    default:
      return { status: "unverified", decision: String(d.verdict), saw, reason: "dump-risk returned no recognisable verdict" };
  }
}

export function viewClanker(c: ClankerOut): { view: CheckView; positive: string | null; note: string | null; unverified: string | null } {
  const saw: Record<string, unknown> = { verdict: c.verdict, clankerVersion: c.clankerVersion, liquidityLocked: c.liquidityLocked };
  if (c.claimsClanker !== undefined) saw.claimsClanker = c.claimsClanker;
  const view: CheckView = { status: "info", decision: c.verdict, saw, reason: "launch provenance — informational, does not change the decision" };
  if (c.verdict === "clanker_verified") {
    if (c.liquidityLocked === true) {
      return { view, positive: `Launched through the Clanker ${c.clankerVersion} factory and its launch LP position is held by a Clanker locker (liquidityLocked: true).`, note: null, unverified: null };
    }
    return {
      view,
      positive: null,
      note: c.liquidityLocked === false
        ? `Launched through the Clanker ${c.clankerVersion} factory, but its launch LP position is no longer locked.`
        : `Launched through the Clanker ${c.clankerVersion} factory; lock status of its launch liquidity was not established.`,
      unverified: null,
    };
  }
  if (c.verdict === "not_clanker") {
    return { view, positive: null, note: c.claimsClanker === true ? "Name or symbol mentions Clanker, but no Clanker factory has a deployment record for it." : null, unverified: null };
  }
  return { view, positive: null, note: null, unverified: "Clanker origin could not be confirmed either way" };
}

/** Largest trade (USD) whose constant-product impact stays at or under `p`,
 *  against the aggregate liquidity dump-risk read. Same model dump-risk uses. */
export function sizeForImpact(aggregateLiquidityUsd: number, p = MAX_IMPACT): number {
  const reserve = aggregateLiquidityUsd / 2;
  return Math.floor((p * reserve) / (1 - p));
}

// ---- handler ----

export async function preTradeBundle(params: Record<string, string>) {
  const raw = (params.address || params.token || params.tokenOut || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… Base token address (address=)");
  const address = getAddress(raw);
  const sizeRaw = (params.amountUsd || params.size || "").trim();
  let tradeSizeUsd: number | null = null;
  if (sizeRaw) {
    tradeSizeUsd = Number(sizeRaw);
    if (!Number.isFinite(tradeSizeUsd) || tradeSizeUsd <= 0) throw new Error("amountUsd must be a positive number");
  }

  // Four of the five checks read the same GoPlus row and DexScreener pairs.
  // Fetched cold in parallel, that is four simultaneous GoPlus requests per call
  // — the fastest way to get rate-limited into an all-unverified answer. One
  // warm-up read lets the rest hit the shared cache. Its result is not used:
  // a failed warm-up just means each check tries (and reports) on its own.
  await Promise.allSettled([goPlusSecurity(address), dexTokenPairs(address)]);
  // A redeemable USD stablecoin has no whale-dump exit to model (see dump-risk).
  const stable = usdStablecoin(address);
  // A Coinbase tokenized stock is a B20 precompile: GoPlus has no row for it, so
  // owner-powers and dump-risk can only fail. Its issuer controls are read by
  // b20-gate, and its exit (pool depth, premium) by the gate's stock path.
  const stock = await findStock(address).catch(() => null);

  const [gateR, b20R, ownerR, dumpR, clankerR] = await Promise.allSettled([
    preTradeGate(tradeSizeUsd !== null ? { address, amountUsd: String(tradeSizeUsd) } : { address }),
    b20Gate({ address }),
    stock ? Promise.resolve(null) : ownerPowers({ address }),
    stable || stock ? Promise.resolve(null) : dumpRiskCore({ address }),
    clankerTokenAudit({ address }),
  ]);

  // The core gate is the one check this product cannot answer without. It only
  // throws on its own input validation, but if it ever does, nothing is billed.
  if (gateR.status === "rejected") {
    throw new Error(`pre-trade-gate could not run (${errText(gateR)}) — not charged, retry shortly`);
  }

  const unverified: Unverified[] = [];
  const failed = (r: PromiseSettledResult<unknown>): CheckView => ({
    status: "unverified",
    decision: null,
    saw: {},
    reason: `check failed to run: ${errText(r)}`,
  });

  const checks: Record<"preTradeGate" | "b20Gate" | "ownerPowers" | "dumpRisk", CheckView> = {
    preTradeGate: viewGate(gateR.value),
    b20Gate: b20R.status === "fulfilled" ? viewB20(b20R.value) : failed(b20R),
    ownerPowers: stock
      ? stockNotApplicable(b20R, stock.sym, "owner-powers is a GoPlus read of an ERC-20 owner; a B20 stock has none — its issuer's powers are listed by b20-gate (issuerControls)")
      : ownerR.status === "fulfilled" && ownerR.value
        ? viewOwner(ownerR.value, gateR.value.established === true, gateR.value.ownerless === true)
        : failed(ownerR),
    dumpRisk: stock
      ? stockNotApplicable(b20R, stock.sym, "holders of a tokenized stock are pools, lenders and Coinbase's authorised participants; exit depth and premium are checked by pre-trade-gate's stock path")
      : stable
      ? { status: "not_applicable", decision: "not_applicable", saw: { stablecoin: stable.symbol }, reason: `${stable.symbol} is a redeemable USD stablecoin — exit is redemption, not a DEX dump; check stablecoin-peg` }
      : dumpR.status === "fulfilled" && dumpR.value
        ? viewDump(dumpR.value)
        : failed(dumpR),
  };
  const GATING: Array<[keyof typeof checks, string]> = [
    ["preTradeGate", "pre-trade-gate"],
    ["b20Gate", "b20-gate"],
    ["ownerPowers", "owner-powers"],
    ["dumpRisk", "dump-risk"],
  ];
  for (const [k, name] of GATING) {
    if (checks[k].status === "unverified") unverified.push({ check: name, reason: checks[k].reason, gating: true });
  }

  const positives: string[] = [];
  const notes: string[] = [];
  let clankerView: CheckView;
  if (clankerR.status === "fulfilled") {
    const c = viewClanker(clankerR.value);
    clankerView = c.view;
    if (c.positive) positives.push(c.positive);
    if (c.note) notes.push(c.note);
    if (c.unverified) unverified.push({ check: "clanker-token-audit", reason: c.unverified, gating: false });
  } else {
    clankerView = { status: "info", decision: null, saw: {}, reason: `informational check failed to run: ${errText(clankerR)}` };
    unverified.push({ check: "clanker-token-audit", reason: clankerView.reason, gating: false });
  }

  const gatingViews = GATING.map(([k, name]) => ({ name, v: checks[k] }));
  const stops = gatingViews.filter((x) => x.v.status === "stop");
  const risks = gatingViews.filter((x) => x.v.status === "risk");
  const gatingUnverified = unverified.filter((u) => u.gating);

  // STOP on any terminal flag, even from a partial read: a confirmed honeypot
  // stands whatever else failed. Otherwise HOLD on any risk OR any unverified
  // gating check. GO only when every applicable gating check returned clean.
  const decision: "GO" | "HOLD" | "STOP" = stops.length ? "STOP" : risks.length || gatingUnverified.length ? "HOLD" : "GO";
  const allApplicableClean = gatingViews.every((x) => x.v.status === "clean" || x.v.status === "not_applicable");
  if (decision === "GO" && !allApplicableClean) throw new Error("internal: GO without every applicable check clean"); // unreachable by construction

  const observedRisks = [
    ...stops.map((x) => `[${x.name}] ${x.v.reason}`),
    ...risks.map((x) => `[${x.name}] ${x.v.reason}`),
  ];

  // Recommended max size — only from a real exit-liquidity read.
  const dump = dumpR.status === "fulfilled" ? dumpR.value : null;
  let sizing: Record<string, unknown>;
  if (decision === "STOP") {
    sizing = { recommendedMaxSizeUsd: null, basis: "decision is STOP — no size is recommended" };
  } else if (!dump || dump.poolsCounted === 0 || dump.aggregateLiquidityUsd <= 0) {
    sizing = { recommendedMaxSizeUsd: null, basis: dump ? "dump-risk found no Base pool liquidity to size against" : "exit-liquidity data unavailable (dump-risk did not run) — no size derived" };
  } else {
    const max = sizeForImpact(dump.aggregateLiquidityUsd);
    const reserve = dump.aggregateLiquidityUsd / 2;
    const impactAtSize = tradeSizeUsd !== null ? +((tradeSizeUsd / (reserve + tradeSizeUsd)) * 100).toFixed(2) : null;
    sizing = {
      recommendedMaxSizeUsd: max,
      maxImpactPct: MAX_IMPACT * 100,
      aggregateLiquidityUsd: dump.aggregateLiquidityUsd,
      poolsCounted: dump.poolsCounted,
      ...(tradeSizeUsd !== null ? { tradeSizeUsd, estImpactAtTradeSizePct: impactAtSize, withinRecommended: tradeSizeUsd <= max } : {}),
      basis: `largest trade whose constant-product impact stays ≤${MAX_IMPACT * 100}% against the aggregate liquidity of ${dump.poolsCounted} Base pool(s) (DexScreener, via dump-risk). A single route uses one pool, so real impact can be higher — pre-trade-gate's route check reports the impact at your size on the deepest pool.`,
    };
  }

  const degraded = gatingUnverified.length > 0;
  const missing = unverified.map((u) => u.check);
  const receiptParams: Record<string, unknown> = tradeSizeUsd !== null ? { address, amountUsd: tradeSizeUsd } : { address };

  return {
    address,
    decision, // GO | HOLD | STOP
    ...(degraded ? { degraded: true } : {}),
    unverified,
    checks: { ...checks, clankerTokenAudit: clankerView },
    observedRisks,
    positives,
    notes,
    sizing,
    receipt: {
      checked: address,
      at: new Date().toISOString(),
      endpoint: ENDPOINT,
      decision,
      ...decisionReceipt({
        endpoint: ENDPOINT,
        params: receiptParams,
        degraded,
        missing,
        ...(degraded
          ? {
              refusalReason: "gating_check_unverified",
              confidenceBasis: `not every gating check could be verified (${gatingUnverified.map((u) => u.check).join(", ")}) — partial read, not billed`,
            }
          : {}),
      }),
      observedRisks,
      recheckAfter: new Date(Date.now() + (decision === "STOP" ? 3600_000 : decision === "HOLD" ? 6 * 3600_000 : 24 * 3600_000)).toISOString(),
    },
    recommendation:
      decision === "STOP"
        ? "Do not trade — a terminal flag is set (see observedRisks)."
        : decision === "HOLD"
          ? degraded && observedRisks.length === 0
            ? "Not verified clean — one or more gating checks could not run (see unverified). Re-check before trading."
            : "Material risks found (see observedRisks). If you trade, size down and stay exit-ready."
          : "Every applicable check ran and came back clean. Stay within the recommended size.",
    note: "Composite of pre-trade-gate, b20-gate (B20 tokens only; N/A otherwise), owner-powers and dump-risk, plus clanker-token-audit as provenance context that never changes the decision. GO only when every applicable check ran clean; any check that could not run is listed in `unverified` and rules GO out. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
