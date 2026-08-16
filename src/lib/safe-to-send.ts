/**
 * Safe to send? — the question an agent asks before it moves value to an address.
 *
 * Built for a measured gap rather than a guess. Across the x402 index, address /
 * counterparty screening has 724 distinct payers against 1,755 calls in 30 days:
 * more buyers than token-safety and less than a third of the repeat use. Agents
 * try it and do not come back, only 8% of listings in that theme reach even
 * three payers, and the best-known answer (obol's EVM address check) went dark
 * on 2026-07-27. The demand is there; nothing answers it well enough to be bound
 * as a permanent tool.
 *
 * Three deliberate shape choices, each taken from what works elsewhere on the
 * network rather than from taste:
 *
 *   - ONE verdict an agent can branch on (STOP / REVIEW / GO), not a data dump.
 *   - A `factors` map where every factor carries a level AND a reason, including
 *     the ones that did not run. A check we skipped and a check that came back
 *     clean must never look the same.
 *   - Nothing is asserted from data we failed to read. A screen that did not run
 *     cannot produce GO, however clean everything else looks.
 *
 * The slow half (archive age lookup, proxy read) is skipped entirely on a
 * sanctions hit — there is nothing left to decide, and the caller gets the
 * answer in ~200ms instead of ~3s.
 */

import "server-only";
import { createPublicClient, getAddress, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { classifyCode } from "./primitives";
import { sanctionsCheck } from "./compliance";
import { addressTrust } from "./address-trust";
import { firstAppearance } from "./wallet-history";
import { proxyCheck } from "./proxy";
import { decisionReceipt, finish } from "./envelope";

/** A wallet younger than this is treated as unestablished: fresh addresses are
 *  what a drainer or a one-shot scam hands you. */
const FRESH_DAYS = 7;

type Level = "clear" | "caution" | "critical" | "unknown" | "skipped";
interface Factor {
  level: Level;
  reason: string;
  [k: string]: unknown;
}

export async function safeToSend(params: Record<string, string>) {
  const raw = (params.address || params.to || params.recipient || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide the address you are about to send to (address=0x…)");
  const address = getAddress(raw) as Address;
  const started = Date.now();

  const factors: Record<string, Factor> = {};
  const client = createPublicClient({ chain: base, transport: baseTransport(8000, true) });

  // ---- fast pass: the two things that can decide the answer on their own ----
  const [sancR, trustR, codeR] = await Promise.allSettled([
    sanctionsCheck({ address }),
    addressTrust({ address }),
    client.getCode({ address }),
  ]);

  const sanc = sancR.status === "fulfilled" ? (sancR.value as { sanctioned: boolean; stale?: boolean | null }) : null;
  if (!sanc) {
    factors.sanctions = { level: "unknown", reason: "OFAC screen did not run — the list could not be loaded this call" };
  } else if (sanc.sanctioned) {
    factors.sanctions = { level: "critical", reason: "Address appears on the OFAC SDN list of sanctioned digital-currency addresses", listStale: sanc.stale ?? null };
  } else {
    factors.sanctions = { level: "clear", reason: "Not on the OFAC SDN list", listStale: sanc.stale ?? null };
  }

  const kindEarly = codeR.status === "fulfilled" ? classifyCode(codeR.value) : null;
  const trust = trustR.status === "fulfilled" ? (trustR.value as { coinbaseVerified: boolean; basename: string | null; verdict: string }) : null;
  if (kindEarly?.isContract) {
    // Coinbase verification and Basenames attach to user accounts. Reporting a
    // token contract as "anonymous" is a caution about nothing, and a factor
    // that cries wolf is worse than one that is absent.
    factors.identity = { level: "skipped", reason: "not applicable — Coinbase verification and Basenames attach to user accounts, not to contracts" };
  } else if (!trust || trust.verdict === "unknown") {
    factors.identity = { level: "unknown", reason: "Verification lookup was unavailable — the address is neither confirmed nor ruled out as anonymous" };
  } else if (trust.coinbaseVerified) {
    factors.identity = { level: "clear", reason: "Coinbase-verified: an onchain attestation ties this address to a KYC'd account", basename: trust.basename };
  } else if (trust.basename) {
    factors.identity = { level: "caution", reason: `Has a Basename (${trust.basename}) but no Coinbase verification — pseudonymous, not identified`, basename: trust.basename };
  } else {
    factors.identity = { level: "caution", reason: "Anonymous: no Coinbase verification and no Basename. Nothing raises the cost of being a throwaway address", basename: null };
  }

  const kind = kindEarly;
  if (!kind) {
    factors.accountType = { level: "unknown", reason: "Could not read the account's code — cannot tell a wallet from a contract" };
  } else if (kind.isContract) {
    factors.accountType = { level: "caution", reason: "This is a CONTRACT, not a wallet. Sending to a contract that does not expect a plain transfer can lose the funds", type: "contract" };
  } else if (kind.delegatedTo) {
    // Since EIP-7702 a wallet can carry code and still sign for itself. That is
    // normal for a smart wallet and must not be reported as a contract.
    factors.accountType = { level: "clear", reason: `Wallet with an EIP-7702 delegation to ${kind.delegatedTo} — a smart-wallet setup, still an account that signs for itself`, type: "eoa_delegated", delegatedTo: kind.delegatedTo };
  } else {
    factors.accountType = { level: "clear", reason: "Plain wallet (EOA)", type: "eoa" };
  }

  // ---- a sanctions hit ends it: nothing below can change the answer ----
  if (factors.sanctions.level === "critical") {
    for (const name of ["age", "upgradeable"]) {
      factors[name] = { level: "skipped", reason: "not checked — the sanctions hit already decides this" };
    }
    return verdictPayload(address, factors, started, params);
  }

  // ---- slower pass ----
  const wantProxy = kind?.isContract === true;
  const [ageR, proxyR] = await Promise.allSettled([
    firstAppearance(address),
    wantProxy ? proxyCheck({ address }) : Promise.resolve(null),
  ]);

  const first = ageR.status === "fulfilled" ? ageR.value : undefined;
  if (ageR.status === "rejected") {
    factors.age = { level: "unknown", reason: "Archive lookup failed — could not establish how long this address has existed" };
  } else if (!first) {
    // Not the same as "new": an address that only ever received tokens through
    // internal transfers is invisible to both probes the search uses.
    factors.age = { level: "caution", reason: "No ETH balance and no sent transaction on Base, so the archive finds nothing to date. Treat as unestablished, not as proven new", ageDays: null };
  } else {
    const ageDays = Math.floor((Date.now() - new Date(first.at).getTime()) / 86400000);
    factors.age = ageDays < FRESH_DAYS
      ? { level: "caution", reason: `First seen on Base ${ageDays} day(s) ago — a fresh address is what a one-shot scam or a drainer hands you`, ageDays, firstSeen: first.at }
      : { level: "clear", reason: `Established: first seen on Base ${ageDays} days ago`, ageDays, firstSeen: first.at };
  }

  if (!wantProxy) {
    factors.upgradeable = { level: "skipped", reason: "not applicable — the recipient is a wallet, not a contract" };
  } else if (proxyR.status !== "fulfilled" || !proxyR.value) {
    factors.upgradeable = { level: "unknown", reason: "Could not read the proxy slots — cannot tell whether this contract's logic can be replaced" };
  } else {
    const p = proxyR.value as { isProxy: boolean; adminType: string; upgradeRisk: string };
    factors.upgradeable = p.isProxy
      ? {
          level: p.upgradeRisk === "high" ? "critical" : "caution",
          reason: p.upgradeRisk === "high"
            ? "Upgradeable proxy whose admin is a single key — the code behind this address can be swapped at any block, after you send"
            : "Upgradeable proxy — the logic behind this address can be replaced, though not by a single unprotected key",
          adminType: p.adminType,
        }
      : { level: "clear", reason: "Not an upgradeable proxy — the code at this address cannot be swapped out from under you" };
  }

  return verdictPayload(address, factors, started, params);
}

function verdictPayload(address: string, factors: Record<string, Factor>, started: number, params: Record<string, string>) {
  const levels = Object.values(factors).map((f) => f.level);
  const unknown = Object.entries(factors).filter(([, f]) => f.level === "unknown").map(([k]) => k);
  const critical = Object.entries(factors).filter(([, f]) => f.level === "critical").map(([k]) => k);
  const caution = Object.entries(factors).filter(([, f]) => f.level === "caution").map(([k]) => k);

  // GO is a positive claim, so it requires that everything material was actually
  // read. Anything unknown drops to REVIEW rather than borrowing confidence from
  // the checks that did run.
  const verdict = critical.length > 0 ? "STOP" : unknown.length > 0 || caution.length > 0 ? "REVIEW" : "GO";

  const guidance =
    verdict === "STOP"
      ? `Do not send. ${critical.map((k) => factors[k].reason).join(" ")}`
      : verdict === "GO"
        ? "Nothing adverse found: screened clean, identity attested, established address, and no upgradeable code behind it. Identity is not intent — this says the recipient is not a known-bad or throwaway address, not that the transaction is correct."
        : `Review before sending. ${[...critical, ...caution, ...unknown].map((k) => `${k}: ${factors[k].reason}`).join(" | ")}`;

  const degraded = unknown.length > 0;
  return finish({
    address,
    verdict, // STOP | REVIEW | GO
    factors,
    checkedFactors: levels.filter((l) => l !== "skipped").length,
    skippedFactors: levels.filter((l) => l === "skipped").length,
    degraded,
    guidance,
    tookMs: Date.now() - started,
    receipt: {
      checked: address,
      endpoint: "safe-to-send",
      decision: verdict,
      ...decisionReceipt({
        endpoint: "safe-to-send",
        params: { address: params.address ?? address },
        degraded,
        missing: unknown,
      }),
    },
    note: "Screens the address you are about to send, approve or sign to: OFAC sanctions, Coinbase/Basename identity, wallet vs contract, how long it has existed, and whether contract logic can be swapped after you send. Every factor reports what it found AND what it could not read; a check that did not run never reads as clean. Not financial advice.",
  });
}
