/**
 * pre-trade-gate for Coinbase tokenized stocks.
 *
 * The generic gate is built for launchpad tokens: a GoPlus honeypot read, a
 * simulated sell, a deployer's history. None of these apply to a B20 stock — it is
 * a native precompile with no deployer, GoPlus has no row for it, and the
 * sell simulation does not cover it — so on 2026-10-17 the gate answered HOLD
 * ("unverified: 4 checks") for NVDAc, every time. An agent following it could
 * never buy a real stock.
 *
 * For an address on the tokenized-stock roster (seeded from chain, topped up from
 * Coinbase's own API) the gate asks the questions that DO decide a stock trade:
 *   - issuance: is it Coinbase's stock (roster) — the honeypot question's answer;
 *   - transferability: is transfer paused, does the transfer policy let an
 *     ordinary address send and receive, and (with wallet=) may THIS wallet
 *     receive it — a blocked receiver reverts the swap;
 *   - price: the DEX premium against the reference, and whether the reference is
 *     frozen (market closed) or abnormally stale (market open);
 *   - route: price impact at this size (same swap-route the generic gate uses);
 *   - corporate actions announced but not yet applied (context).
 *
 * The same Cobalt `enforce` guard is attached on GO and HOLD.
 */

import "server-only";
import { createPublicClient, getAddress, keccak256, parseAbi, toBytes, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { decisionReceipt } from "./envelope";
import { swapRoute } from "./swap-route";
import { stockFairValue } from "./stock-fair-value";
import { readTransferPolicy, B20_POLICY_REGISTRY, type TokenizedStock } from "./tokenized-stocks";
import type { GuardResult } from "./liquidity-guard";

const TRANSFER_RECEIVER_POLICY = keccak256(toBytes("TRANSFER_RECEIVER_POLICY"));
const abi = parseAbi([
  "function policyId(bytes32) view returns (uint64)",
  "function isAuthorized(uint64, address) view returns (bool)",
  "function policyExists(uint64) view returns (bool)",
]);

/** May `wallet` receive `token`? null when unreadable. Policy 0 = unset = allow. */
async function mayReceive(token: string, wallet: Address): Promise<boolean | null> {
  try {
    const c = createPublicClient({ chain: base, transport: baseTransport(6000) });
    const id = await c.readContract({ address: getAddress(token), abi, functionName: "policyId", args: [TRANSFER_RECEIVER_POLICY] });
    if (id === 0n) return true;
    // isAuthorized never reverts — on a missing policy it answers anyway, so
    // existence is checked first (Base's integrator guidance).
    const exists = await c.readContract({ address: B20_POLICY_REGISTRY, abi, functionName: "policyExists", args: [id] }).catch(() => true);
    if (!exists) return null;
    return await c.readContract({ address: B20_POLICY_REGISTRY, abi, functionName: "isAuthorized", args: [id, wallet] });
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export async function stockGate(
  stock: TokenizedStock,
  opts: { address: string; amountUsd: string; tradeSizeUsd: number; wallet: Address | null; guardP: Promise<GuardResult> },
) {
  const { address, amountUsd, tradeSizeUsd, wallet, guardP } = opts;
  const [fvR, routeR, policyR, recvR] = await Promise.allSettled([
    stockFairValue({ symbol: stock.token, amountUsd }),
    swapRoute({ tokenOut: address, amountUsd }),
    readTransferPolicy(stock.token),
    wallet ? mayReceive(stock.token, wallet) : Promise.resolve(null),
  ]);
  const guard = await guardP;

  const fv = fvR.status === "fulfilled" ? (fvR.value as Record<string, unknown>) : null;
  const route = routeR.status === "fulfilled" ? (routeR.value as Record<string, unknown>) : null;
  const policy = policyR.status === "fulfilled" ? policyR.value : null;
  const walletMayReceive = recvR.status === "fulfilled" ? recvR.value : null;

  const paused = Array.isArray(fv?.pausedFeatures) ? (fv!.pausedFeatures as string[]) : [];
  const premiumBps = num(fv?.premiumBps);
  const verdict = String(fv?.verdict ?? "");
  const impact = num(route?.estPriceImpactPct);
  const canaryOk = policy ? policy.canaryMaySend === true && policy.canaryMayReceive === true : null;

  const unavailable: string[] = [];
  if (!fv) unavailable.push("stock-fair-value");
  if (!route) unavailable.push("swap-route");
  if (canaryOk === null) unavailable.push("transfer policy");
  if (wallet && walletMayReceive === null) unavailable.push("wallet eligibility");
  const degraded = unavailable.length > 0;

  const terminal: string[] = [];
  if (paused.some((p) => /transfer/i.test(p))) terminal.push(`issuer has paused ${paused.join(", ")}`);
  if (walletMayReceive === false) terminal.push("this wallet is not authorised to receive the stock — the swap would revert");
  if (verdict === "not_trading") terminal.push("no live Base pool — nothing to trade against");

  const observedRisks: string[] = [...terminal];
  if (paused.length && !terminal.some((t) => t.startsWith("issuer has paused"))) observedRisks.push(`issuer has paused: ${paused.join(", ")}`);
  if (canaryOk === false) observedRisks.push("transfer policy no longer lets an ordinary address send/receive freely");
  if (verdict === "wide" && premiumBps !== null) observedRisks.push(`DEX price ${premiumBps > 0 ? "+" : ""}${premiumBps} bps from the reference`);
  if (fv?.referenceStale === true) observedRisks.push("reference price abnormally stale while the market is open");
  if (impact !== null && impact >= 10) observedRisks.push(`price impact ${impact}% at this size`);
  if (degraded) observedRisks.push(`unverified: ${unavailable.join(", ")}`);

  const stop = terminal.length > 0;
  const hold = observedRisks.length > 0;
  const decision = stop ? "STOP" : hold ? "HOLD" : "GO";

  const context: string[] = [
    "Regulated issuer: Coinbase can pause transfers, change who may hold the stock and seize a blocked holder's balance — the controls of a securities wrapper, checked here only as they stand now (b20-gate reports the powers in full).",
  ];
  if (verdict === "no_reference") context.push("No reference price is published for this stock, so the premium cannot be measured — compare with the listed share price yourself.");
  if (fv?.referenceFrozen === true) context.push(`US market closed — the reference is Friday's close; the premium is weekend drift and lenders still value this stock at the frozen price.`);
  const pending = fv?.pendingCorporateAction as { description?: string; announcedAt?: string } | null | undefined;
  if (pending) context.push(`${pending.description ?? "Corporate action"} announced ${pending.announcedAt ?? ""}, not yet applied — balances do not change, the multiplier does.`);

  return {
    address,
    tradeSizeUsd,
    decision,
    assetType: "tokenized-stock",
    stock: { symbol: stock.sym, ticker: stock.ticker, name: stock.name, issuer: "Coinbase (B20)" },
    // A regulated issuer's controls (pause, policy, seize) are the product, not a
    // rug signal: the bundle reads owner powers as context for an established asset.
    established: true,
    ownerless: false,
    ...(degraded ? { degraded: true, unverifiedChecks: unavailable } : {}),
    enforce: decision === "STOP" ? { available: false, reason: "decision is STOP — do not trade" } : guard,
    receipt: {
      checked: address,
      at: new Date().toISOString(),
      endpoint: "pre-trade-gate",
      decision,
      ...decisionReceipt({ endpoint: "pre-trade-gate", params: { address }, degraded, missing: degraded ? unavailable : [] }),
      observedRisks,
      context,
      checks: {
        issuance: "on Coinbase's tokenized-stock roster",
        transfer: policy
          ? { senderPolicyId: policy.senderPolicyId, receiverPolicyId: policy.receiverPolicyId, openToAnyAddress: canaryOk, pausedFeatures: paused }
          : "unavailable",
        ...(wallet ? { wallet: { address: wallet, mayReceive: walletMayReceive } } : {}),
        fairValue: fv
          ? { session: fv.session, referenceFrozen: fv.referenceFrozen, reference: fv.reference, dexPriceUsd: (fv.dex as { priceUsd?: number } | null)?.priceUsd ?? null, premiumBps, verdict }
          : "unavailable",
        route: route ? { estPriceImpactPct: impact, verdict: route.verdict } : "unavailable",
      },
      wouldChangeCall: stop
        ? "Nothing while the transfer is blocked or there is no pool."
        : "A narrower premium, a fresh reference at the reopen, or a smaller size.",
      recheckAfter: new Date(Date.now() + (stop ? 3600_000 : hold ? 3 * 3600_000 : 24 * 3600_000)).toISOString(),
    },
    recommendation:
      decision === "STOP"
        ? `Do not trade ${stock.sym} — ${terminal.join("; ")}.`
        : decision === "HOLD"
          ? `Trade ${stock.sym} with caution — ${observedRisks.join("; ")}.`
          : `${stock.sym} is Coinbase's stock, transferable, priced ${premiumBps !== null ? `within ${Math.abs(premiumBps)} bps of its reference` : "on Base"}${impact !== null ? ` with ~${impact}% impact at $${tradeSizeUsd}` : ""}. Proceed within normal size.`,
    note: "pre-trade-gate, tokenized-stock path: issuance (Coinbase roster), transfer policy and pauses, wallet eligibility (wallet=), DEX premium vs the reference and its freshness, and route impact — the checks that decide a stock trade, in place of launchpad-token checks that do not apply to B20 stocks. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
