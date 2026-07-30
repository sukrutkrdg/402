/**
 * Domain check — registration age, expiry and lifecycle status from RDAP.
 *
 * WHY: the same buyer that needs email-verify needs this one sentence earlier.
 * Domain age is the single strongest cheap signal in vendor, invoice and
 * counterparty fraud — the payment-detail change that arrives from a lookalike
 * domain registered eleven days ago is the classic case — and an agent about to
 * transact, onboard a supplier or trust a link has no way to ask it. RDAP is the
 * registries' own protocol and free, so like the URL and email endpoints there
 * is no paid upstream underneath: the margin is ours.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: guess. RDAP coverage is universal across
 * gTLDs but patchy across country registries — plenty of ccTLDs publish nothing,
 * and several publish a record with the dates stripped. Where the registry does
 * not answer we return a refusal naming what was missing, rather than an
 * "unknown age" that a caller could read as "not new". A wrong GO here is
 * somebody wiring money to a two-week-old domain.
 */

import "server-only";
import { assertSafeUrl } from "./ssrf";
import { decisionReceipt } from "./envelope";

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const UA = "x402-bazaar/1.0 (+https://402.com.tr; paid API on behalf of a caller)";

/** Fresh enough to be the fraud signal callers actually screen for. */
const NEW_DOMAIN_DAYS = 90;
/** An expiry this close is an operational risk even on an old domain. */
const EXPIRING_SOON_DAYS = 30;

/** EPP statuses that mean the domain is not usable now, whatever its age. */
const DEAD_STATUS = new Set([
  "client hold", "server hold", "pending delete", "redemption period", "pending restore",
]);
/** EPP statuses worth a human look before trusting the domain. */
const WATCH_STATUS = new Set([
  "pending transfer", "pending update", "pending renew", "pending create", "inactive",
]);

interface Bootstrap {
  at: number;
  /** tld → RDAP base URLs */
  map: Map<string, string[]>;
}
let bootstrapCache: Bootstrap | null = null;

/**
 * IANA's registry of which TLD is served by which RDAP endpoint.
 *
 * Going through the bootstrap rather than a redirector like rdap.org is what
 * lets us tell "this registry publishes nothing" apart from "the lookup failed" —
 * the first is a permanent property of the TLD and belongs in the answer, the
 * second is a retry. Cached for a day; the file changes rarely and is ~300 KB.
 */
async function loadBootstrap(): Promise<Map<string, string[]>> {
  if (bootstrapCache && Date.now() - bootstrapCache.at < BOOTSTRAP_TTL_MS) return bootstrapCache.map;
  const res = await timedFetch(BOOTSTRAP_URL, "application/json");
  const json = (await res.json()) as { services?: Array<[string[], string[]]> };
  const map = new Map<string, string[]>();
  for (const [tlds, urls] of json.services ?? []) {
    const bases = urls.filter((u) => u.startsWith("https://"));
    if (!bases.length) continue;
    for (const t of tlds) map.set(t.toLowerCase(), bases);
  }
  if (map.size === 0) throw new Error("RDAP bootstrap returned no services");
  bootstrapCache = { at: Date.now(), map };
  return map;
}

/**
 * One HTTPS GET with the guards this codebase applies to every outbound fetch.
 *
 * The URLs here come from IANA rather than from the caller, but they are still
 * addresses we did not write down ourselves, and a registry is free to redirect.
 * Same gate, every hop.
 */
async function timedFetch(url: string, accept: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = await assertSafeUrl(current, "RDAP endpoint");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(safe.toString(), {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { accept, "user-agent": UA },
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("RDAP redirect without a location");
      current = new URL(loc, safe).toString();
      continue;
    }
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_BYTES) throw new Error("RDAP response too large");
    return res;
  }
  throw new Error("Too many RDAP redirects");
}

/** Normalise what a caller typed into a bare, punycoded domain name. */
export function normaliseDomain(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.split("/")[0].split("?")[0].split("#")[0];
  s = s.split("@").pop() ?? s; // someone pasted an email address
  s = s.replace(/:\d+$/, ""); // port
  s = s.replace(/\.$/, ""); // trailing root dot
  if (!s) return "";
  // URL does IDN → punycode for us, and rejects the genuinely malformed.
  try {
    return new URL(`https://${s}`).hostname;
  } catch {
    return s;
  }
}

const SHAPE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Second-level labels that are themselves registry space (`co.uk`, `com.tr`,
 * `ac.jp`), not somebody's domain. Used to stop the walk below from ever
 * reporting a public suffix as "the registered domain".
 */
const REGISTRY_SLD = new Set(["co", "com", "net", "org", "edu", "gov", "mil", "ac", "or", "ne", "gr", "sch", "nom", "info", "biz"]);

/**
 * The names to ask the registry about, longest first.
 *
 * A registry only knows registrable domains: ask it about `blog.github.com` and
 * it answers 404, exactly as it would for a name nobody ever bought. Reading
 * that 404 as "not registered" is how this endpoint told a caller that mail from
 * a real company's subdomain was forged. So we walk up to the parent and report
 * on that, stopping before anything that is registry space rather than a domain.
 */
export function lookupCandidates(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i + 2 <= labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    const parts = candidate.split(".");
    if (parts.length === 2 && REGISTRY_SLD.has(parts[0])) break; // co.uk, com.tr …
    out.push(candidate);
  }
  return out;
}

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}
interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown;
  publicIds?: Array<{ type?: string; identifier?: string }>;
}
interface RdapDomain {
  events?: RdapEvent[];
  status?: string[];
  entities?: RdapEntity[];
  nameservers?: Array<{ ldhName?: string }>;
  secureDNS?: { delegationSigned?: boolean };
}

function eventDate(doc: RdapDomain, action: string): string | null {
  const e = (doc.events ?? []).find((x) => (x.eventAction ?? "").toLowerCase() === action);
  const d = e?.eventDate;
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Registrar name out of the jCard blob, without pulling in a vCard parser. */
function registrarName(doc: RdapDomain): string | null {
  for (const ent of doc.entities ?? []) {
    if (!(ent.roles ?? []).some((r) => r.toLowerCase() === "registrar")) continue;
    const card = ent.vcardArray;
    if (Array.isArray(card) && Array.isArray(card[1])) {
      for (const field of card[1] as unknown[]) {
        if (Array.isArray(field) && field[0] === "fn" && typeof field[3] === "string") {
          return field[3].slice(0, 120);
        }
      }
    }
    const id = (ent.publicIds ?? []).find((p) => p.identifier)?.identifier;
    if (id) return `IANA registrar ${id}`;
  }
  return null;
}

const days = (from: number, to: number) => Math.floor((to - from) / 86_400_000);

export async function domainCheck(params: Record<string, string>) {
  const raw = (params.domain || "").trim();
  if (!raw) throw new Error("Missing 'domain'");
  if (raw.length > 300) throw new Error("Domain too long");

  const domain = normaliseDomain(raw);
  const now = Date.now();

  if (!domain || !SHAPE.test(domain)) {
    return {
      domain: raw,
      decision: "STOP",
      registered: null,
      reasons: ["invalid_domain_syntax"],
      checkedAt: new Date(now).toISOString(),
      receipt: {
        checked: raw,
        endpoint: "domain-check",
        decision: "STOP",
        ...decisionReceipt({
          endpoint: "domain-check",
          params: { domain },
          degraded: false,
          confidenceBasis: "input is not a valid domain name; no registry lookup was needed",
        }),
      },
      guidance: "Not a valid domain name — check for a typo before using it anywhere.",
      method: "syntax only",
    };
  }

  const tld = domain.slice(domain.lastIndexOf(".") + 1);

  // Anything below is a refusal rather than a verdict: we could not read the
  // registry, so we do not know, and saying so is the only honest answer. The
  // receipt has to be NESTED — the gateway refunds on `receipt.refundable`, so a
  // spread-at-top-level refusal is billed while its own body promises a refund.
  const refuse = (reason: string, missing: string[], guidance: string, extra: Record<string, unknown> = {}) => ({
    domain,
    decision: "REFUSE",
    registered: null,
    reasons: [reason],
    checkedAt: new Date(now).toISOString(),
    receipt: {
      checked: domain,
      endpoint: "domain-check",
      decision: "REFUSE",
      ...decisionReceipt({
        endpoint: "domain-check",
        params: { domain },
        degraded: true,
        missing,
        confidenceBasis: "the registry did not provide the registration record",
      }),
    },
    guidance,
    method: "RDAP (IANA bootstrap → registry endpoint)",
    ...extra,
  });

  let bases: string[] | undefined;
  try {
    bases = (await loadBootstrap()).get(tld);
  } catch {
    return refuse(
      "rdap_bootstrap_unavailable",
      ["iana-rdap-bootstrap"],
      "Could not reach IANA's RDAP directory — retry rather than treating this as a result.",
      { tld },
    );
  }

  if (!bases?.length) {
    return refuse(
      "registry_publishes_no_rdap",
      [`rdap-service-for-.${tld}`],
      `The .${tld} registry does not publish RDAP, so registration age cannot be checked for this domain. This is a permanent property of the TLD, not a temporary failure — retrying will not help.`,
      { tld },
    );
  }

  // Try each registry base in turn: IANA lists more than one for some TLDs, and
  // one dead base should not turn a checkable domain into a billed refusal.
  const query = async (name: string): Promise<Response | null> => {
    for (const raw of bases) {
      const base = raw.endsWith("/") ? raw : `${raw}/`;
      try {
        return await timedFetch(`${base}domain/${encodeURIComponent(name)}`, "application/rdap+json, application/json");
      } catch {
        /* try the next base for this TLD */
      }
    }
    return null;
  };

  // Walk from the name we were given up to its registrable parent (see
  // lookupCandidates): a registry 404s for a subdomain exactly as it does for a
  // name nobody registered, and the two must not produce the same answer.
  const candidates = lookupCandidates(domain);
  let res: Response | null = null;
  let resolvedName = domain;
  let anyRegistryAnswered = false;
  for (const candidate of candidates) {
    const r = await query(candidate);
    if (!r) continue;
    anyRegistryAnswered = true;
    if (r.status === 404) continue; // not this level — try the parent
    res = r;
    resolvedName = candidate;
    break;
  }

  if (!res) {
    if (!anyRegistryAnswered) {
      return refuse(
        "registry_unreachable",
        [`rdap-query-.${tld}`],
        "The registry's RDAP service did not answer — retry rather than treating this as a result.",
        { tld },
      );
    }
    // Every level answered 404, including the registrable parent: nobody owns it.
    return {
      domain,
      decision: "STOP",
      registered: false,
      reasons: ["not_registered"],
      tld,
      checkedNames: candidates,
      checkedAt: new Date(now).toISOString(),
      receipt: {
        checked: domain,
        endpoint: "domain-check",
        decision: "STOP",
        ...decisionReceipt({
          endpoint: "domain-check",
          params: { domain },
          degraded: false,
          confidenceBasis: `registry answered that no such domain is registered (checked ${candidates.join(", ")})`,
        }),
      },
      guidance:
        "The registry has no registration for this domain, nor for the domain it sits under. Mail from it cannot be genuine and links to it will not resolve — treat any message claiming to come from it as forged.",
      method: "RDAP (IANA bootstrap → registry endpoint)",
    };
  }

  const isSubdomain = resolvedName !== domain;

  if (!res.ok) {
    return refuse(
      "registry_error",
      [`rdap-query-.${tld}`],
      `The registry answered ${res.status} for this lookup — retry rather than treating this as a result.`,
      { tld, registryStatus: res.status },
    );
  }

  let doc: RdapDomain;
  try {
    doc = (await res.json()) as RdapDomain;
  } catch {
    return refuse("registry_response_unreadable", [`rdap-query-.${tld}`], "The registry returned a response we could not parse.", { tld });
  }

  const createdAt = eventDate(doc, "registration");
  const expiresAt = eventDate(doc, "expiration");
  const updatedAt = eventDate(doc, "last changed");
  const statuses = (doc.status ?? []).map((s) => s.toLowerCase());
  const nameservers = (doc.nameservers ?? []).map((n) => (n.ldhName ?? "").toLowerCase()).filter(Boolean);
  const registrar = registrarName(doc);
  const dnssec = doc.secureDNS?.delegationSigned ?? null;

  // A record with no registration date can't answer the question that sells this
  // endpoint. Several ccTLD registries return exactly that, so it is a refusal
  // with the field named — not a GO on the strength of "it exists".
  if (!createdAt) {
    return refuse(
      "registration_date_not_published",
      ["registration-event"],
      `The .${tld} registry publishes a record for this domain but withholds its registration date, so its age cannot be established.`,
      {
        registered: true,
        tld,
        expiresAt,
        updatedAt,
        registrar,
        statuses,
        nameservers,
        dnssec,
      },
    );
  }

  const ageDays = days(Date.parse(createdAt), now);
  const daysToExpiry = expiresAt ? days(now, Date.parse(expiresAt)) : null;
  const dead = statuses.filter((s) => DEAD_STATUS.has(s));
  const watch = statuses.filter((s) => WATCH_STATUS.has(s));
  const expired = daysToExpiry !== null && daysToExpiry < 0;
  const isNew = ageDays < NEW_DOMAIN_DAYS;
  const expiringSoon = daysToExpiry !== null && daysToExpiry >= 0 && daysToExpiry <= EXPIRING_SOON_DAYS;

  const reasons: string[] = [];
  if (dead.length) reasons.push("registry_hold_or_deletion");
  if (expired) reasons.push("registration_expired");
  if (isNew) reasons.push("recently_registered");
  if (expiringSoon) reasons.push("expires_within_30_days");
  if (watch.length) reasons.push("pending_registry_operation");
  if (!nameservers.length) reasons.push("no_nameservers_delegated");

  const decision = dead.length || expired ? "STOP" : isNew || expiringSoon || watch.length || !nameservers.length ? "HOLD" : "GO";

  const guidance =
    dead.length || expired
      ? "The registry has this domain on hold, in deletion or past expiry — it is not a live domain right now. Do not transact with anything claiming to come from it."
      : isNew
        ? `Registered ${ageDays} day(s) ago. New domains are the standard vehicle for invoice and vendor-impersonation fraud — verify the counterparty through a channel that predates this domain before sending anything.`
        : expiringSoon
          ? `Live, but the registration expires in ${daysToExpiry} day(s). Anything depending on it — mail, links, webhooks — stops when it lapses.`
          : watch.length
            ? "Live, but the registry has a pending operation on it (transfer or update). Worth confirming ownership before you rely on it."
            : !nameservers.length
              ? "Registered but with no nameservers delegated, so nothing on it resolves today."
              : `Established domain, registered ${ageDays} day(s) ago, with nothing unusual in its registry record.`;

  return {
    domain,
    // What the registry actually answered about. For a subdomain that is the
    // parent — say so, rather than letting the caller read the parent's age as
    // if the exact name they asked about had been registered that long.
    registrableDomain: resolvedName,
    isSubdomain,
    decision,
    registered: true,
    ageDays,
    createdAt,
    expiresAt,
    daysToExpiry,
    updatedAt,
    registrar,
    statuses,
    nameservers,
    dnssec,
    tld,
    reasons,
    checkedAt: new Date(now).toISOString(),
    receipt: {
      checked: resolvedName,
      endpoint: "domain-check",
      decision,
      ...decisionReceipt({
        endpoint: "domain-check",
        params: { domain },
        degraded: false,
        confidenceBasis: isSubdomain
          ? `registry RDAP record for ${resolvedName}, the registrable domain under which ${domain} sits`
          : "registry RDAP record consulted: registration and expiry events, status codes and delegation",
      }),
    },
    guidance: isSubdomain ? `${domain} is a subdomain of ${resolvedName}; registries only record registrable domains, so this is ${resolvedName}'s record. ${guidance}` : guidance,
    method: "RDAP (IANA bootstrap → registry endpoint). Registry data only — no page fetch, no reputation feed.",
    disclaimer:
      "Age and status come from the registry, which is authoritative for those. They say nothing about what the domain is used for: an old domain can be compromised and a new one can be legitimate.",
  };
}
