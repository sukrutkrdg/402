/**
 * Email verification — syntax, DNS deliverability, disposable and role detection.
 *
 * WHY: business-data/enrichment is one of the thin categories on the x402 index
 * (25 sellers, 92% of them earning) and every agent that signs up a user, quotes
 * a lead or emails an invoice needs this before it sends anything. Like the URL
 * and OFAC endpoints, the data is free — DNS — so the margin is ours.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: talk SMTP. Connecting to port 25 to probe a
 * mailbox is unreliable (most providers accept everything, then bounce), widely
 * rate-limited, blocked outbound on serverless, and treated as abuse by some
 * operators. So this answers "can mail for this domain be delivered, and does
 * this address look like a real person's" — not "does this exact mailbox exist".
 * The response says so, rather than implying certainty we can't have.
 */

import "server-only";
import { resolveMx, resolve4, resolve6 } from "node:dns/promises";
import { decisionReceipt } from "./envelope";

const DNS_TIMEOUT_MS = 6000;

/**
 * Throwaway-inbox providers. A curated set of the ones that actually show up in
 * signup abuse, not an exhaustive list — claimed as such in the response, since
 * an unlisted disposable domain returning "not disposable" would otherwise read
 * as a guarantee.
 */
const DISPOSABLE = new Set([
  "10minutemail.com", "20minutemail.com", "33mail.com", "anonaddy.com", "anonbox.net",
  "burnermail.io", "dispostable.com", "dropmail.me", "emailondeck.com", "fakeinbox.com",
  "fakemail.net", "getairmail.com", "getnada.com", "grr.la", "guerrillamail.biz",
  "guerrillamail.com", "guerrillamail.de", "guerrillamail.net", "guerrillamail.org",
  "harakirimail.com", "inboxbear.com", "incognitomail.com", "jetable.org", "mail-temp.com",
  "mail7.io", "mailcatch.com", "maildrop.cc", "mailinator.com", "mailnesia.com",
  "mailsac.com", "mailtemp.info", "minuteinbox.com", "mintemail.com", "moakt.com",
  "mohmal.com", "mytemp.email", "nowmymail.com", "opayq.com", "pokemail.net",
  "sharklasers.com", "simplelogin.io", "spam4.me", "spamgourmet.com", "sute.jp",
  "temp-mail.io", "temp-mail.org", "tempail.com", "tempinbox.com", "tempm.com",
  "tempmail.dev", "tempmail.ninja", "tempmailo.com", "tempr.email", "throwawaymail.com",
  "trashmail.com", "trashmail.de", "trbvm.com", "vomoto.com", "wegwerfmail.de",
  "yopmail.com", "yopmail.fr", "yopmail.net", "zetmail.com",
]);

/** Consumer mailbox providers — not a problem, but it tells a B2B agent a lot. */
const FREE_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.co.in", "ymail.com",
  "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "msn.com", "aol.com",
  "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de",
  "mail.com", "mail.ru", "yandex.com", "yandex.ru", "zoho.com", "qq.com", "163.com",
  "126.com", "naver.com", "hanmail.net", "web.de", "t-online.de", "orange.fr", "free.fr",
]);

/** Shared/functional mailboxes — real, but nobody's personal inbox. */
const ROLE_LOCALS = new Set([
  "abuse", "admin", "administrator", "billing", "careers", "compliance", "contact",
  "customerservice", "dev", "devnull", "enquiries", "feedback", "finance", "help",
  "hello", "hostmaster", "hr", "info", "inquiries", "invoices", "it", "jobs", "legal",
  "mail", "marketing", "media", "newsletter", "noc", "noreply", "no-reply", "office",
  "orders", "postmaster", "press", "privacy", "root", "sales", "security", "signup",
  "spam", "support", "sysadmin", "team", "webmaster", "welcome",
]);

/**
 * Practical address syntax. Not full RFC 5322 — that grammar permits quoted local
 * parts and comments no mail provider accepts in practice, and a validator that
 * blesses them would be worse than useless to a caller trying to decide whether
 * to send.
 */
const SYNTAX = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/**
 * Damerau-Levenshtein distance, i.e. Levenshtein plus adjacent transposition.
 *
 * The transposition case is the point: `gmial.com` is the single most common
 * real typo for `gmail.com`, and plain Levenshtein scores it 2, so a one-edit
 * check without transpositions misses exactly the mistake people actually make.
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[m][n];
}

/**
 * Suggest the domain a typo was probably aiming at.
 *
 * A domain that IS a known provider is never a typo of another one — without
 * that guard `gmail.com` gets "corrected" to `ymail.com`, one substitution away,
 * and a perfectly good address gets held for review.
 */
export function suggestDomain(domain: string): string | null {
  if (FREE_PROVIDERS.has(domain)) return null;
  for (const known of FREE_PROVIDERS) if (editDistance(domain, known) === 1) return known;
  return null;
}

/**
 * A DNS lookup, with the outcome we actually need: records, or a failure tagged
 * with whether DNS *answered*.
 *
 * "No such domain" (ENOTFOUND/NXDOMAIN) and "domain exists, no records of this
 * type" (ENODATA) are definitive answers. A timeout, SERVFAIL or REFUSED is not —
 * we simply don't know. Collapsing those into one `null` is what made a
 * misspelled domain come back as "retry later" instead of "this will bounce".
 */
async function lookup<T>(p: Promise<T[]>, ms: number): Promise<{ records: T[] | null; answered: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol("timeout");
  try {
    const r = await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
    if (r === TIMED_OUT) return { records: null, answered: false };
    return { records: r, answered: true };
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "";
    const definitive = code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN";
    return { records: definitive ? [] : null, answered: definitive };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function emailVerify(params: Record<string, string>) {
  const raw = (params.email || "").trim();
  if (!raw) throw new Error("Missing 'email'");
  if (raw.length > 254) throw new Error("Address too long (max 254 characters)");

  const email = raw.toLowerCase();
  const at = email.lastIndexOf("@");
  const local = at > 0 ? email.slice(0, at) : "";
  // Punycode the domain half before validating it. Without this, `münchen.de`
  // and every internationalised TLD fail an ASCII-only syntax check and are told
  // "not a valid address — do not send", which is simply wrong: DNS resolves
  // them fine, and the sibling domain endpoint already handles them correctly.
  const rawDomain = at > 0 ? email.slice(at + 1) : "";
  let domain = rawDomain;
  if (rawDomain) {
    try {
      const ascii = new URL(`https://${rawDomain}`).hostname;
      if (ascii) domain = ascii;
    } catch {
      /* leave it as typed — the syntax check below will reject it */
    }
  }
  const syntaxValid = Boolean(local) && SYNTAX.test(`${local}@${domain}`);

  // Nothing DNS can tell us about a string that isn't an address — answer from
  // syntax alone rather than burning a lookup on it.
  if (!syntaxValid || !domain) {
    const receipt = decisionReceipt({
      endpoint: "email-verify",
      params: { email },
      degraded: false,
      confidenceBasis: "address failed syntax validation; no DNS lookup was needed",
    });
    return {
      email: raw,
      decision: "STOP",
      deliverable: false,
      reasons: ["invalid_syntax"],
      syntaxValid: false,
      domain: domain || null,
      checkedAt: new Date().toISOString(),
      receipt: { checked: email, endpoint: "email-verify", decision: "STOP", ...receipt },
      guidance: "Not a valid address — do not attempt to send.",
      method: "syntax only",
    };
  }

  const [mx, a4, a6] = await Promise.all([
    lookup(resolveMx(domain), DNS_TIMEOUT_MS),
    lookup(resolve4(domain), DNS_TIMEOUT_MS),
    lookup(resolve6(domain), DNS_TIMEOUT_MS),
  ]);

  // "We don't know" has to survive a PARTIAL read, not just a total one. If the
  // MX lookup timed out we cannot say the domain accepts no mail, however
  // clearly the A lookup answered — an empty `records` from a failed lookup is
  // absence of evidence, and reporting it as "nothing resolves" is how a working
  // address gets told it will bounce. So the verdict needs every lookup it
  // depends on to have actually answered.
  const dnsUnavailable = !mx.answered && !a4.answered && !a6.answered;
  const partialDns = !dnsUnavailable && (!mx.answered || !a4.answered || !a6.answered);
  const unanswered = [
    ...(mx.answered ? [] : ["mx"]),
    ...(a4.answered ? [] : ["a"]),
    ...(a6.answered ? [] : ["aaaa"]),
  ];
  // Nothing resolves AND every lookup answered → the domain isn't registered/served.
  const domainMissing =
    !dnsUnavailable && !partialDns && !(mx.records ?? []).length && !(a4.records ?? []).length && !(a6.records ?? []).length;
  const mxHosts = (mx.records ?? [])
    .slice()
    .sort((x, y) => x.priority - y.priority)
    .map((r) => ({ host: r.exchange, priority: r.priority }));
  const domainResolves = Boolean((a4.records ?? []).length || (a6.records ?? []).length);
  // A domain with no MX but an A record accepts mail at that host per RFC 5321 —
  // legacy, but real, so it isn't undeliverable.
  const acceptsMail = mxHosts.length > 0 || domainResolves;

  const disposable = DISPOSABLE.has(domain);
  const freeProvider = FREE_PROVIDERS.has(domain);
  const role = ROLE_LOCALS.has(local) || ROLE_LOCALS.has(local.replace(/[._-]/g, ""));
  const suggestion = suggestDomain(domain);

  const reasons: string[] = [];
  // Nothing resolved at all is worth saying separately (it usually means a typo
  // or an unregistered domain), but the actionable fact is the same either way:
  // mail cannot be delivered. So report both rather than replacing one with the
  // other — a caller filtering on "accepts no mail" must still catch this case.
  if (domainMissing) reasons.push("domain_does_not_resolve");
  if (!acceptsMail && !dnsUnavailable && !partialDns) reasons.push("domain_accepts_no_mail");
  // Only claim the A-record fallback when the MX lookup actually came back empty.
  if (mx.answered && mxHosts.length === 0 && domainResolves) reasons.push("no_mx_falls_back_to_a_record");
  if (disposable) reasons.push("disposable_provider");
  if (role) reasons.push("role_account");
  if (freeProvider) reasons.push("consumer_mailbox");
  if (suggestion) reasons.push("possible_domain_typo");
  if (dnsUnavailable) reasons.push("dns_unavailable");
  // Only worth reporting when it changes the answer. If a record we DID read
  // proves mail is accepted, a gap elsewhere is noise; if nothing proves it, the
  // gap is the whole story — we cannot tell "no mail" from "didn't look".
  // A gap only counts when it could change the answer: no MX read at all, or
  // nothing that proves mail is accepted. A missing AAAA behind a healthy MX
  // changes nothing and should not dent the caller's confidence.
  const materialGap = partialDns && (!mx.answered || !acceptsMail);
  if (materialGap) reasons.push("dns_partially_unavailable");

  // A partial read can still say GO — records we DID see prove mail is accepted.
  // It can never say STOP: "no records" from a lookup that never answered is not
  // evidence of absence, so that case refuses instead.
  const decision = dnsUnavailable
    ? "REFUSE"
    : acceptsMail
      ? disposable || suggestion || role
        ? "HOLD"
        : "GO"
      : partialDns
        ? "REFUSE"
        : "STOP";

  const degraded = dnsUnavailable || (partialDns && !acceptsMail);
  const receipt = decisionReceipt({
    endpoint: "email-verify",
    params: { email },
    degraded,
    missing: dnsUnavailable
      ? ["dns-mx-and-address-records"]
      : materialGap
        ? unanswered.map((r) => `dns-${r}-record`)
        : [],
    confidenceBasis: dnsUnavailable
      ? "DNS did not answer — deliverability could not be established"
      : materialGap
        ? `some DNS lookups did not answer (${unanswered.join(", ")}); the verdict rests only on the records that did`
        : "syntax, MX/A records and provider classification all consulted; mailbox existence is not probed",
  });

  return {
    email: raw,
    decision,
    deliverable: dnsUnavailable || (partialDns && !acceptsMail) ? null : acceptsMail,
    reasons,
    syntaxValid: true,
    domain,
    localPart: local,
    mx: mxHosts,
    domainResolves,
    disposable,
    freeProvider,
    roleAccount: role,
    suggestedDomain: suggestion,
    checkedAt: new Date().toISOString(),
    receipt: { checked: email, endpoint: "email-verify", decision, ...receipt },
    guidance: dnsUnavailable
      ? "DNS was unreachable for this domain — retry rather than treating this as a result."
      : partialDns && !acceptsMail
        ? `Part of DNS did not answer (${unanswered.join(", ")}), and nothing we could read shows a way to receive mail — that is not the same as "it will bounce". Retry before acting.`
      : domainMissing
        ? "Nothing resolves for that domain — no MX, A or AAAA records. Mail cannot be delivered; check for a typo."
        : !acceptsMail
          ? "The domain publishes no way to receive mail. Sending will bounce."
          : disposable
          ? "Deliverable, but a throwaway inbox — fine for a one-off, not for an account you need to reach later."
          : suggestion
            ? `Deliverable, but the domain is one character from ${suggestion} — likely a typo worth confirming.`
            : role
              ? "Deliverable shared mailbox (support@, info@ and similar) — reaches a team, not a person."
              : "Domain accepts mail and nothing looks off.",
    method:
      "Syntax + DNS (MX, A, AAAA) + disposable/role/provider classification. No SMTP probe, so mailbox existence is NOT verified — most providers accept-then-bounce, which makes SMTP checks unreliable anyway.",
    disclaimer:
      "The disposable-domain list is a curated subset of common providers, not exhaustive; 'disposable: false' is not a guarantee.",
  };
}
