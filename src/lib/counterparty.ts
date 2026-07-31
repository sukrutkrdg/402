/**
 * Counterparty check — is this supplier/invoice worth trusting?
 *
 * WHY THIS ONE, and why it is a composite: the questions an agent actually faces
 * before it pays somebody are not separable. "Is this domain young?", "will mail
 * to this address bounce?", "is this name on a sanctions list?" and "does this
 * company legally exist?" are four APIs and four judgement calls; the caller
 * wants one answer. We already own three of the four, which is the whole reason
 * this can exist at a price the parts cannot command — nobody else on the
 * network can assemble it.
 *
 * All four inputs are free: RDAP, DNS, the Treasury's own OFAC export, and
 * GLEIF's public LEI register. No metered upstream sits under any of it.
 */

import "server-only";
import { domainCheck } from "./domain-check";
import { emailVerify } from "./email-verify";
import { sanctionsName } from "./sanctions-name";
import { decisionReceipt } from "./envelope";

const GLEIF = "https://api.gleif.org/api/v1/lei-records";
const TIMEOUT_MS = 8000;
const MAX_BYTES = 400_000;

/** Legal-form suffixes that differ between how a company signs and how it is registered. */
const LEGAL_SUFFIX =
  /\b(inc|incorporated|llc|l\.?l\.?c|ltd|limited|plc|corp|corporation|co|company|gmbh|ag|a\.?s|as|sa|s\.?a|nv|n\.?v|bv|b\.?v|ab|oy|aps|sarl|srl|spa|pty|holding|holdings|group)\b\.?/g;

export function normalizeCompany(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const stripLegalForm = (s: string) => normalizeCompany(s).replace(LEGAL_SUFFIX, "").replace(/\s+/g, " ").trim();

export interface LeiRecord {
  lei: string;
  legalName: string;
  status: string | null;
  registrationStatus: string | null;
  jurisdiction: string | null;
  country: string | null;
  city: string | null;
  lastUpdate: string | null;
  nextRenewal: string | null;
}

export interface LeiResult {
  queried: string;
  /** exact = names match once normalised; strong = match ignoring legal form. */
  match: "exact" | "strong" | null;
  record: LeiRecord | null;
  /** Names the register offered that we did NOT accept as a match. */
  candidates: string[];
  /** The register answered (vs. we could not reach it). */
  answered: boolean;
}

/**
 * Look a company up in the global LEI register.
 *
 * The register's name filter is a token search, not an exact match: asking for
 * "Coinbase Global, Inc." returns 76,000 records, the second of which matched on
 * the word "Inc". So every candidate is re-checked here and only an exact or
 * legal-form-insensitive match is reported as found — the rest come back as
 * suggestions. Reporting the wrong company as "verified" is the one failure this
 * endpoint must not have.
 */
export async function leiLookup(name: string): Promise<LeiResult> {
  const queried = name.trim();
  const out: LeiResult = { queried, match: null, record: null, candidates: [], answered: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let json: { data?: Array<{ attributes?: Record<string, unknown> }> };
  try {
    const res = await fetch(`${GLEIF}?filter[entity.legalName]=${encodeURIComponent(queried)}&page[size]=10`, {
      signal: ctrl.signal,
      headers: { accept: "application/vnd.api+json", "user-agent": "x402-bazaar/1.0 (+https://402.com.tr)" },
    });
    if (!res.ok) return out;
    const text = await res.text();
    if (text.length > MAX_BYTES) return out;
    json = JSON.parse(text);
  } catch {
    return out;
  } finally {
    clearTimeout(timer);
  }

  out.answered = true;
  const wantExact = normalizeCompany(queried);
  const wantLoose = stripLegalForm(queried);

  for (const item of json.data ?? []) {
    const a = (item.attributes ?? {}) as {
      lei?: string;
      entity?: { legalName?: { name?: string }; status?: string; jurisdiction?: string; category?: string; legalAddress?: { country?: string; city?: string } };
      registration?: { status?: string; lastUpdateDate?: string; nextRenewalDate?: string };
    };
    const legalName = a.entity?.legalName?.name ?? "";
    if (!legalName) continue;
    const tier: "exact" | "strong" | null =
      normalizeCompany(legalName) === wantExact ? "exact" : stripLegalForm(legalName) === wantLoose && wantLoose ? "strong" : null;
    if (!tier) {
      if (out.candidates.length < 5) out.candidates.push(legalName);
      continue;
    }
    // Keep the first exact match; a strong match never displaces an exact one.
    if (!out.record || (tier === "exact" && out.match !== "exact")) {
      out.match = tier;
      out.record = {
        lei: a.lei ?? "",
        legalName,
        status: a.entity?.status ?? null,
        registrationStatus: a.registration?.status ?? null,
        jurisdiction: a.entity?.jurisdiction ?? null,
        country: a.entity?.legalAddress?.country ?? null,
        city: a.entity?.legalAddress?.city ?? null,
        lastUpdate: a.registration?.lastUpdateDate ?? null,
        nextRenewal: a.registration?.nextRenewalDate ?? null,
      };
    }
  }
  return out;
}

const NEUTRAL_LEI_NOTE =
  "No LEI is NOT a red flag: the register covers entities that trade in financial markets, and most small suppliers have never needed one. Treat a found LEI as corroboration, never its absence as suspicion.";

export async function companyLei(params: Record<string, string>) {
  const name = (params.name || "").trim();
  if (!name) throw new Error("Missing 'name' — pass the company's legal name");
  if (name.length > 200) throw new Error("Name too long (max 200 characters)");

  const r = await leiLookup(name);
  if (!r.answered) {
    const err = new Error("The LEI register did not respond — retry rather than treating this as a result");
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  return {
    query: name,
    found: Boolean(r.record),
    match: r.match,
    ...r.record,
    candidates: r.candidates,
    checkedAt: new Date().toISOString(),
    source: "GLEIF — the global LEI register (public, authoritative for legal-entity identity)",
    method:
      "Name matched against the register, then re-checked here: the register's own filter is a token search that returns tens of thousands of rows for a common word, so only an exact match — or one that differs solely in legal form (Inc/Ltd/GmbH) — is reported as found. Anything else is returned as a candidate, not a match.",
    note: NEUTRAL_LEI_NOTE,
  };
}

type SubDecision = { decision?: string; reasons?: string[]; receipt?: { confidence?: { band?: string } } };

export async function counterpartyCheck(params: Record<string, string>) {
  const email = (params.email || "").trim();
  const rawDomain = (params.domain || "").trim();
  const name = (params.name || "").trim();
  // An email carries a domain; asking for both would be asking twice.
  const domain = rawDomain || (email.includes("@") ? email.split("@").pop()! : "");
  if (!domain) throw new Error("Pass a 'domain' or an 'email' — one of them is required");

  const [domainRes, emailRes, sanctionsRes, lei] = await Promise.all([
    domainCheck({ domain }).catch((e: Error) => ({ decision: "REFUSE", reasons: ["domain_check_failed"], error: e.message })),
    email ? emailVerify({ email }).catch((e: Error) => ({ decision: "REFUSE", reasons: ["email_check_failed"], error: e.message })) : Promise.resolve(null),
    name ? sanctionsName({ name }).catch((e: Error) => ({ decision: "REFUSE", reasons: ["sanctions_check_failed"], error: e.message })) : Promise.resolve(null),
    name ? leiLookup(name) : Promise.resolve(null),
  ]);

  const d = domainRes as SubDecision & { ageDays?: number; registrableDomain?: string; isSubdomain?: boolean; registered?: boolean | null };
  const e = emailRes as (SubDecision & { deliverable?: boolean | null; disposable?: boolean; roleAccount?: boolean }) | null;
  const s = sanctionsRes as (SubDecision & { sanctioned?: boolean | null; matchCount?: number; matches?: unknown[] }) | null;

  const reasons: string[] = [];
  const add = (prefix: string, sub: SubDecision | null) => {
    for (const r of sub?.reasons ?? []) reasons.push(`${prefix}:${r}`);
  };
  add("domain", d);
  add("email", e);
  add("sanctions", s);

  // What we could not look at, so the receipt can say so rather than implying a
  // clean bill of health across checks that never ran.
  const missing: string[] = [];
  if (!name) missing.push("legal-name (no sanctions screen, no LEI lookup)");
  if (!email) missing.push("email-address (no deliverability check)");
  if (lei && !lei.answered) missing.push("lei-register (did not respond)");

  const stops = [d.decision === "STOP", e?.decision === "STOP", s?.decision === "STOP"].filter(Boolean).length;
  const holds = [d.decision === "HOLD", e?.decision === "HOLD", s?.decision === "HOLD"].filter(Boolean).length;
  const refusals = [d.decision === "REFUSE", e?.decision === "REFUSE", s?.decision === "REFUSE"].filter(Boolean).length;
  const ran = [d, e, s].filter(Boolean).length;

  // A lapsed LEI registration is worth a look; a missing one is not.
  const leiLapsed = Boolean(lei?.record && lei.record.registrationStatus && lei.record.registrationStatus !== "ISSUED");
  if (leiLapsed) reasons.push(`lei:registration_${String(lei!.record!.registrationStatus).toLowerCase()}`);
  if (lei?.record && lei.record.status && lei.record.status !== "ACTIVE") reasons.push(`lei:entity_${String(lei.record.status).toLowerCase()}`);

  // A check the caller ASKED for that could not run is not a pass. The first
  // version of this returned GO for a sanctioned name because the OFAC feed was
  // down and the other three checks were clean — the worst answer this endpoint
  // can give. So: nothing usable at all → REFUSE; anything failed → never better
  // than HOLD, with the gap named in `reasons` and in the receipt.
  if (refusals > 0) reasons.push("incomplete:some_checks_could_not_run");
  const decision =
    refusals === ran
      ? "REFUSE"
      : stops > 0
        ? "STOP"
        : holds > 0 || leiLapsed || refusals > 0
          ? "HOLD"
          : "GO";
  for (const [label, sub] of [["domain", d], ["email", e], ["sanctions", s]] as const) {
    if (sub?.decision === "REFUSE") missing.push(`${label}-check (did not complete)`);
  }

  const guidance =
    decision === "REFUSE"
      ? "None of the checks could be completed — retry rather than treating this as a clean result."
      : decision === "STOP"
        ? "At least one hard signal failed. Do not send money or credentials on this counterparty until it is resolved through a channel you already trust."
        : decision === "HOLD"
          ? refusals > 0
            ? "Not a clean result: at least one check could not be completed, so this is 'unverified', not 'fine'. See `receipt.confidence.basis` for which one, and re-run before relying on it."
            : "Nothing disqualifying, but something is off — the detail is in `reasons`. Verify through a channel that predates this contact (a phone number you already had, not one from the invoice)."
          : "Nothing unusual across the checks that ran. That is not a guarantee of good faith, only an absence of the cheap warning signs.";

  return {
    input: { domain, email: email || null, name: name || null },
    decision,
    reasons,
    signals: {
      domain: {
        decision: d.decision,
        registered: d.registered ?? null,
        ageDays: d.ageDays ?? null,
        registrableDomain: d.registrableDomain ?? domain,
        isSubdomain: d.isSubdomain ?? false,
      },
      email: e ? { decision: e.decision, deliverable: e.deliverable ?? null, disposable: e.disposable ?? false, roleAccount: e.roleAccount ?? false } : null,
      sanctions: s ? { decision: s.decision, sanctioned: s.sanctioned ?? null, matchCount: s.matchCount ?? 0 } : null,
      lei: lei ? { answered: lei.answered, found: Boolean(lei.record), match: lei.match, record: lei.record, candidates: lei.candidates } : null,
    },
    checkedAt: new Date().toISOString(),
    receipt: {
      checked: `${domain}${name ? ` / ${name}` : ""}`,
      endpoint: "counterparty-check",
      decision,
      ...decisionReceipt({
        endpoint: "counterparty-check",
        params: { domain, email, name },
        degraded: decision === "REFUSE",
        missing,
        confidenceBasis:
          decision === "REFUSE"
            ? "no check completed"
            : missing.length
              ? `ran ${ran} of 4 checks; ${missing.join("; ")}`
              : "domain registration, mail deliverability, OFAC name screening and the LEI register were all consulted",
      }),
    },
    guidance,
    method:
      "Four public sources in one call: RDAP (domain age and registry status), DNS (mail deliverability), the U.S. Treasury OFAC SDN export (name screening) and GLEIF (legal-entity register). No paid data provider is involved.",
    disclaimer: `Screening aid, not a compliance determination and not legal advice. Name screening matches names, not identities. ${NEUTRAL_LEI_NOTE}`,
  };
}
