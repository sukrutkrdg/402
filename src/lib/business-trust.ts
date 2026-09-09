/**
 * Company search, TLS cert peek, password breach (HIBP k-anonymity), URL risk.
 */

import "server-only";
import { createHash } from "node:crypto";
import tls from "node:tls";
import { assertSafeUrl } from "./ssrf";

const UA = "x402-bazaar/1.0 (+https://402.com.tr; paid API on behalf of a caller)";
const TIMEOUT_MS = 10_000;
const at = () => new Date().toISOString();

export async function companySearch(params: Record<string, string>) {
  const q = (params.q || params.name || "").trim();
  if (!q) throw new Error("Provide q= company name");
  if (q.length < 2) throw new Error("q= too short");
  const jurisdiction = (params.jurisdiction || params.country || "").trim().toLowerCase();

  let url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(q)}&per_page=5`;
  if (jurisdiction) url += `&jurisdiction_code=${encodeURIComponent(jurisdiction)}`;

  await assertSafeUrl(url, "company-search");
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error(`Company register unavailable: ${(e as Error).message}`);
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error("OpenCorporates rate-limited or requires a key right now — retry later");
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`OpenCorporates responded ${res.status}`);
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  const json = (await res.json()) as {
    results?: { companies?: Array<{ company: Record<string, unknown> }> };
  };
  const rows = json.results?.companies ?? [];
  const companies = rows.slice(0, 5).map((r) => {
    const c = r.company;
    return {
      name: c.name ?? null,
      companyNumber: c.company_number ?? null,
      jurisdiction: c.jurisdiction_code ?? null,
      incorporationDate: c.incorporation_date ?? null,
      companyType: c.company_type ?? null,
      currentStatus: c.current_status ?? null,
      opencorporatesUrl: c.opencorporates_url ?? null,
    };
  });

  return {
    query: q,
    jurisdiction: jurisdiction || null,
    found: companies.length > 0,
    count: companies.length,
    companies,
    attribution: "Data from OpenCorporates.com",
    note: "Public company-register search. Not a credit score and not KYC.",
    checkedAt: at(),
  };
}

export async function sslCheck(params: Record<string, string>) {
  let host = (params.host || params.domain || "").trim().toLowerCase();
  if (!host) throw new Error("Provide host= e.g. example.com");
  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+$/i.test(host) || host.includes("..")) throw new Error("Invalid host");

  const port = Number(params.port || "443");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");

  const cert = await new Promise<tls.PeerCertificate>((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: TIMEOUT_MS },
      () => {
        const c = socket.getPeerCertificate();
        socket.end();
        if (!c || !c.valid_to) reject(new Error("No certificate presented"));
        else resolve(c);
      },
    );
    socket.on("error", reject);
    socket.setTimeout(TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error("TLS handshake timed out"));
    });
  }).catch((e) => {
    const err = new Error(`TLS probe failed: ${(e as Error).message}`);
    (err as Error & { status?: number }).status = 502;
    throw err;
  });

  const validTo = new Date(cert.valid_to);
  const validFrom = new Date(cert.valid_from);
  const now = Date.now();
  const daysRemaining = Math.floor((validTo.getTime() - now) / 86_400_000);
  const expired = daysRemaining < 0;
  const expiringSoon = !expired && daysRemaining <= 30;

  let decision: "go" | "hold" | "stop" = "go";
  if (expired) decision = "stop";
  else if (expiringSoon) decision = "hold";

  return {
    host,
    port,
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
    daysRemaining,
    expired,
    expiringSoon,
    fingerprint256: cert.fingerprint256 ?? null,
    serialNumber: cert.serialNumber ?? null,
    authorized: true, // we set rejectUnauthorized:false — report authorization separately
    authorizationNote: "Certificate chain trust is not asserted; dates and identity fields are.",
    decision,
    checkedAt: at(),
  };
}

/** HIBP Pwned Passwords range API — k-anonymity, no full password sent. */
export async function breachCheck(params: Record<string, string>) {
  const password = params.password ?? params.value ?? "";
  if (!password) throw new Error("Provide password= to check (sent as SHA-1 prefix only, never stored)");
  if (password.length > 200) throw new Error("password= too long");

  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const url = `https://api.pwnedpasswords.com/range/${prefix}`;
  await assertSafeUrl(url, "breach-check");

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, "add-padding": "true" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error(`HIBP unavailable: ${(e as Error).message}`);
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HIBP responded ${res.status}`);
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  const body = await res.text();
  let count = 0;
  for (const line of body.split("\n")) {
    const [suf, n] = line.trim().split(":");
    if (suf === suffix) {
      count = Number(n) || 0;
      break;
    }
  }

  const pwned = count > 0;
  const decision: "go" | "hold" | "stop" = pwned ? (count > 100 ? "stop" : "hold") : "go";

  return {
    pwned,
    occurrences: count,
    decision,
    note:
      "Checked via Have I Been Pwned Pwned Passwords k-anonymity API. Only a 5-char SHA-1 prefix left this server; the password itself is not logged or stored. Email breach lookup is not offered here (requires a HIBP key).",
    checkedAt: at(),
  };
}

const LOOKALIKE: Array<[string, string]> = [
  ["0", "o"], ["1", "l"], ["1", "i"], ["rn", "m"], ["vv", "w"], ["cl", "d"],
];

function stripWww(h: string) {
  return h.replace(/^www\./, "");
}

export function urlRisk(params: Record<string, string>) {
  const raw = (params.url || params.href || "").trim();
  if (!raw) throw new Error("Provide url=");
  let u: URL;
  try {
    u = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error("url= is not a valid URL");
  }

  const reasons: string[] = [];
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" && u.protocol !== "http:") reasons.push(`Unusual scheme ${u.protocol}`);
  if (u.protocol === "http:") reasons.push("Not HTTPS");
  if (netIp(host)) reasons.push("Host is a raw IP");
  if (host.split(".").length >= 5) reasons.push("Unusually deep subdomain chain");
  if (/-(login|secure|account|verify|update|support)\./i.test(host)) reasons.push("Credential-themed subdomain label");
  if (/(login|signin|verify|wallet|seed|mnemonic)/i.test(u.pathname)) reasons.push("Sensitive path keywords");
  if (u.username || u.password) reasons.push("Embedded credentials in URL");
  if ([...u.searchParams.keys()].some((k) => /pass|token|seed|mnemonic|private/i.test(k))) {
    reasons.push("Sensitive query parameter names");
  }

  const brand = (params.brand || "").trim().toLowerCase();
  if (brand) {
    const h = stripWww(host);
    if (h !== brand && h !== `www.${brand}` && !h.endsWith(`.${brand}`)) {
      const flat = h.replace(/[.-]/g, "");
      const bflat = brand.replace(/[.-]/g, "");
      let similar = flat.includes(bflat) || bflat.includes(flat);
      for (const [a, b] of LOOKALIKE) {
        if (flat.replaceAll(a, b) === bflat || flat.replaceAll(b, a) === bflat) similar = true;
      }
      if (similar) reasons.push(`Host looks like a lookalike of brand '${brand}'`);
    }
  }

  let decision: "go" | "hold" | "stop" = "go";
  if (reasons.length >= 3) decision = "stop";
  else if (reasons.length >= 1) decision = "hold";

  return {
    url: u.toString(),
    host,
    reasons,
    decision,
    note: "Heuristic URL risk only — not a malware scan or Safe Browsing verdict.",
    checkedAt: at(),
  };
}

function netIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}
