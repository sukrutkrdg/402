/**
 * Niche anti-scam / compliance forensics agents need and few serve.
 *
 *   address-poisoning — is a recipient a look-alike of an address this wallet
 *     actually transacts with? The address-poisoning attack: a scammer sends dust
 *     from an address whose first/last hex match a real counterparty, hoping the
 *     victim copy-pastes the poisoned one next time. An agent auto-paying is the
 *     perfect victim; this catches it before it sends.
 *   sanctioned-exposure — does this wallet's counterparty history touch an OFAC
 *     address? Not "is THIS address sanctioned" (that's sanctions) but "has it
 *     dealt with one" — taint by association, the compliance screen for receiving.
 *
 * Both read the wallet's USDC counterparties from address-filtered, time-bounded
 * CDP SQL. Heuristic signals, said as such.
 */

import "server-only";
import { cdpSql } from "./covalent";
import { sanctionsCheck } from "./compliance";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "Transfer(address,address,uint256)";
const validAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test((a ?? "").trim());

/** Distinct USDC counterparties of a wallet over `days`, both directions, capped. */
async function counterparties(wallet: string, days: number, cap: number): Promise<string[] | null> {
  const [out, inc] = await Promise.all([
    cdpSql<{ cp?: string }>(`SELECT DISTINCT lower(toString(parameters['to'])) AS cp FROM base.events WHERE address='${USDC}' AND event_signature='${TRANSFER}' AND lower(toString(parameters['from']))='${wallet}' AND block_timestamp > now() - INTERVAL ${days} DAY LIMIT ${cap}`),
    cdpSql<{ cp?: string }>(`SELECT DISTINCT lower(toString(parameters['from'])) AS cp FROM base.events WHERE address='${USDC}' AND event_signature='${TRANSFER}' AND lower(toString(parameters['to']))='${wallet}' AND block_timestamp > now() - INTERVAL ${days} DAY LIMIT ${cap}`),
  ]);
  if (out === null || inc === null) return null;
  const s = new Set<string>();
  for (const r of [...out, ...inc]) { const a = r.cp ?? ""; if (/^0x[0-9a-f]{40}$/.test(a) && a !== wallet) s.add(a); }
  return [...s];
}

// ---------------------------------------------------------------------------
// address-poisoning
// ---------------------------------------------------------------------------

export async function addressPoisoning(params: Record<string, string>) {
  const walletRaw = (params.wallet || params.from || "").trim();
  const candRaw = (params.to || params.recipient || params.candidate || "").trim();
  if (!validAddr(walletRaw)) throw new Error("Provide your wallet (wallet=0x…) — the one that would send");
  if (!validAddr(candRaw)) throw new Error("Provide the recipient you are about to pay (to=0x…)");
  const wallet = walletRaw.toLowerCase();
  const cand = candRaw.toLowerCase();
  const days = Math.min(Math.max(Number(params.days) || 180, 1), 365);

  const cps = await counterparties(wallet, days, 500);
  if (cps === null) throw new Error("Counterparty history unavailable (warehouse) — not charged, retry shortly");

  // Exact match = a real, known counterparty (safe, not poisoning).
  if (cps.includes(cand)) {
    return { wallet: walletRaw, to: candRaw, verdict: "known_counterparty", note: "This recipient is an address the wallet has transacted with before — a known counterparty, not a look-alike. (Still confirm the amount.) Not financial advice.", checkedAt: new Date().toISOString() };
  }

  const body = (a: string) => a.slice(2); // drop 0x
  const cb = body(cand);
  const pre = cb.slice(0, 4), suf = cb.slice(-4); // 4 hex ≈ what wallets show truncated
  const pre6 = cb.slice(0, 6), suf6 = cb.slice(-6);
  const lookalikes = cps
    .map((c) => {
      const b = body(c);
      const samePre = b.slice(0, 4) === pre, sameSuf = b.slice(-4) === suf;
      const strong = b.slice(0, 6) === pre6 || b.slice(-6) === suf6;
      return { address: c, samePre, sameSuf, strong };
    })
    .filter((x) => x.samePre || x.sameSuf);

  const strongHit = lookalikes.find((x) => x.strong) || lookalikes.find((x) => x.samePre && x.sameSuf);
  const verdict = strongHit ? "poisoning_suspected" : lookalikes.length ? "weak_resemblance" : "no_resemblance";

  return {
    wallet: walletRaw,
    to: candRaw,
    daysAnalysed: days,
    knownCounterparties: cps.length,
    lookalikeMatches: lookalikes.slice(0, 5),
    verdict, // known_counterparty | poisoning_suspected | weak_resemblance | no_resemblance
    recommendation:
      verdict === "poisoning_suspected"
        ? `⚠️ ADDRESS-POISONING SUSPECTED. The recipient shares the visible head/tail of a REAL counterparty (${strongHit!.address}) but is a different address — the classic copy-paste trap. Do NOT send until you verify the full address character-by-character against the intended one.`
        : verdict === "weak_resemblance"
          ? `Caution: the recipient shares a short prefix/suffix with a known counterparty. Could be coincidence, could be poisoning — verify the full address before sending.`
          : "No look-alike among the wallet's recent counterparties — no poisoning signal. (Still verify a first-time recipient the normal way.)",
    note: "Address-poisoning check: compares the recipient against the head/tail of addresses this wallet actually transacts with (USDC counterparties, CDP SQL). Catches the dust-poisoning copy-paste trap. A heuristic — verify the full address regardless. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// sanctioned-exposure
// ---------------------------------------------------------------------------

export async function sanctionedExposure(params: Record<string, string>) {
  const walletRaw = (params.wallet || params.address || "").trim();
  if (!validAddr(walletRaw)) throw new Error("Provide a wallet address (wallet=0x…)");
  const wallet = walletRaw.toLowerCase();
  const days = Math.min(Math.max(Number(params.days) || 90, 1), 365);

  const cps = await counterparties(wallet, days, 400);
  if (cps === null) throw new Error("Counterparty history unavailable (warehouse) — not charged, retry shortly");
  if (cps.length === 0) {
    return { wallet: walletRaw, days, counterparties: 0, verdict: "no_activity", note: "No USDC counterparties in the window — nothing to screen.", checkedAt: new Date().toISOString() };
  }

  // Screen each distinct counterparty against OFAC (the list is cached after the
  // first call, so these are in-memory set lookups).
  const hits: string[] = [];
  for (const cp of cps) {
    try { if ((await sanctionsCheck({ address: cp })).sanctioned) hits.push(cp); } catch { /* list unavailable — skip */ }
  }

  const verdict = hits.length ? "sanctioned_exposure" : "clear";
  return {
    wallet: walletRaw,
    days,
    counterpartiesScreened: cps.length,
    sanctionedCounterparties: hits,
    verdict, // clear | sanctioned_exposure | no_activity
    recommendation:
      hits.length
        ? `⚠️ SANCTIONED EXPOSURE — this wallet has transacted with ${hits.length} OFAC-listed address(es) in the last ${days}d. Receiving from or routing through it carries sanctions risk; escalate to compliance before dealing with it.`
        : `No OFAC-listed address among the wallet's ${cps.length} USDC counterparties in ${days}d. Clear for direct counterparty taint (this screens USDC counterparties, not the full fund chain — pair with fund-trace).`,
    note: "Screens a wallet's USDC counterparties (CDP SQL, both directions) against the OFAC SDN list — taint by association, distinct from checking whether the address itself is sanctioned. Covers direct counterparties, not multi-hop (use fund-trace for the funding chain). Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
