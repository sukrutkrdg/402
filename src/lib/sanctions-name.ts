/**
 * OFAC name screening — sanctions checking for people and companies, not wallets.
 *
 * WHY: identity/compliance is the least crowded category on the x402 index (nine
 * sellers, all of them earning, the highest median price on the network) and the
 * only sanctions endpoints we had screened crypto addresses. Every agent that
 * onboards a counterparty, pays an invoice or signs up a vendor needs the name
 * side of this, and it has nothing to do with a blockchain.
 *
 * DATA: the official U.S. Treasury OFAC exports — SDN.CSV (primary names) and
 * ALT.CSV (a.k.a./f.k.a. aliases, where sanctioned parties actually hide). Free,
 * authoritative, refreshed daily by Treasury. Cached in memory for six hours and
 * served stale-but-flagged if Treasury is unreachable, so a screening never
 * silently becomes a guess.
 *
 * HONESTY: this is a screening aid, not a determination. A name match is not
 * proof of identity — real compliance requires a human confirming date of birth,
 * address or registration number against the SDN entry. Every response says so,
 * and single-word queries are labelled unreliable rather than scored.
 */

import "server-only";
import { decisionReceipt } from "./envelope";

const SDN_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";
const ALT_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV";
const TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 25_000;

export interface Entry {
  ent: number;
  name: string;
  norm: string;
  tokens: string[];
  type: string;
  program: string;
  alias: boolean;
}

let cache: { entries: Entry[]; fetchedAt: number } | null = null;

/**
 * Normalise for comparison: OFAC writes names in many shapes, and a screening
 * that only matches byte-for-byte is worthless. Diacritics folded, punctuation
 * dropped, corporate suffixes left in place (they carry signal).
 */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse one CSV line honouring quoted fields; OFAC uses "-0-" for empty. */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((f) => {
    const t = f.trim();
    return t === "-0-" ? "" : t;
  });
}

function makeEntry(ent: number, name: string, type: string, program: string, alias: boolean): Entry | null {
  const norm = normalizeName(name);
  if (!norm) return null;
  return {
    ent,
    name,
    norm,
    tokens: norm.split(" ").filter((t) => t.length > 1),
    type: type || "individual/entity",
    program,
    alias,
  };
}

async function download(url: string): Promise<string> {
  // Treasury 302s to a signed S3 URL, so redirects must be followed.
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`OFAC export responded ${res.status}`);
  return res.text();
}

/**
 * Turn the two Treasury exports into one searchable list. Exported so the CSV
 * quirks (quoted commas, "-0-" placeholders, aliases keyed by entity number) can
 * be tested without the network.
 */
export function parseExports(sdn: string, alt: string): Entry[] {
  const entries: Entry[] = [];
  const programOf = new Map<number, string>();
  const typeOf = new Map<number, string>();

  for (const line of sdn.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = csvFields(line);
    const ent = Number(f[0]);
    if (!Number.isFinite(ent)) continue;
    const e = makeEntry(ent, f[1] ?? "", f[2] ?? "", f[3] ?? "", false);
    if (e) {
      entries.push(e);
      programOf.set(ent, e.program);
      typeOf.set(ent, e.type);
    }
  }
  // ALT.CSV: ent_num, alt_num, alt_type, alt_name, alt_remarks
  for (const line of alt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = csvFields(line);
    const ent = Number(f[0]);
    if (!Number.isFinite(ent)) continue;
    const e = makeEntry(ent, f[3] ?? "", typeOf.get(ent) ?? "", programOf.get(ent) ?? "", true);
    if (e) entries.push(e);
  }
  return entries;
}

async function loadList(): Promise<{ entries: Entry[]; fetchedAt: number; stale: boolean }> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return { ...cache, stale: false };
  try {
    const [sdn, alt] = await Promise.all([download(SDN_URL), download(ALT_URL)]);
    const entries = parseExports(sdn, alt);
    // Sanity: an implausibly small list means a truncated or tampered download,
    // and screening against it would return a false "clear".
    if (entries.length < 5000) throw new Error("OFAC list implausibly small — refusing to screen against it");
    cache = { entries, fetchedAt: Date.now() };
    return { ...cache, stale: false };
  } catch (err) {
    if (cache) return { ...cache, stale: true }; // stale-but-flagged beats no answer
    throw new Error(`OFAC list unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type MatchKind = "exact" | "strong" | "partial";

export interface Match {
  name: string;
  matchedAs: "primary" | "alias";
  match: MatchKind;
  sdnEntity: number;
  type: string;
  program: string;
}

/**
 * Screen a name against the OFAC SDN list.
 *
 * Three tiers, deliberately conservative — in compliance a false "sanctioned"
 * does real damage to a real person, so nothing is scored as a hit unless the
 * whole query is accounted for:
 *   exact   — normalised strings are identical
 *   strong  — every token of a multi-token query appears in the listed name
 *   partial — a multi-token query shares all but one token (surfaced, not a hit)
 * A single-token query is reported without a tier, because "SMITH" matching
 * "JOHN SMITH" tells you nothing.
 */
export interface Screening {
  norm: string;
  singleToken: boolean;
  matches: Match[];
  hit: boolean;
}

/**
 * Pure matching against an already-loaded list — exported so the tiers can be
 * tested for real, since a wrong tier here is what would brand an innocent party
 * as sanctioned.
 */
export function screen(entries: Entry[], query: string): Screening {
  const norm = normalizeName(query);
  const qTokens = norm.split(" ").filter((t) => t.length > 1);
  const singleToken = qTokens.length < 2;

  const matches: Match[] = [];
  for (const e of entries) {
    let kind: MatchKind | null = null;
    if (e.norm === norm) kind = "exact";
    else if (!singleToken && qTokens.every((t) => e.tokens.includes(t))) kind = "strong";
    else if (!singleToken && qTokens.filter((t) => e.tokens.includes(t)).length === qTokens.length - 1) {
      kind = "partial";
    } else if (singleToken && e.tokens.includes(qTokens[0] ?? norm)) kind = "partial";
    if (!kind) continue;
    matches.push({
      name: e.name,
      matchedAs: e.alias ? "alias" : "primary",
      match: kind,
      sdnEntity: e.ent,
      type: e.type,
      program: e.program,
    });
    if (matches.length >= 200) break; // a query this broad is not a screening
  }

  const rank: Record<MatchKind, number> = { exact: 0, strong: 1, partial: 2 };
  matches.sort((a, b) => rank[a.match] - rank[b.match] || a.name.length - b.name.length);
  return {
    norm,
    singleToken,
    matches,
    hit: matches.some((m) => m.match === "exact" || m.match === "strong"),
  };
}

export async function sanctionsName(params: Record<string, string>) {
  const query = (params.name || "").trim();
  if (!query) throw new Error("Missing 'name' — pass a person or company name to screen");
  if (query.length > 200) throw new Error("Name too long (max 200 characters)");
  if (!normalizeName(query)) throw new Error("Name contains no comparable characters");

  const { entries, fetchedAt, stale } = await loadList();
  const { norm, singleToken, matches, hit } = screen(entries, query);
  const top = matches.slice(0, 25);

  const decision = stale ? "REFUSE" : hit ? "STOP" : top.length ? "HOLD" : "GO";
  const receipt = decisionReceipt({
    endpoint: "sanctions-name",
    params: { name: query },
    degraded: stale,
    missing: stale ? ["current-OFAC-export (served a cached list)"] : [],
    confidenceBasis: stale
      ? "Treasury export was unreachable — screened against a cached list"
      : singleToken
        ? "screened against the current OFAC export, but a single-word name cannot be scored reliably"
        : "screened against the current OFAC export (SDN primary names + aliases)",
  });

  return {
    query,
    normalized: norm,
    decision,
    sanctioned: stale ? null : hit,
    matchCount: matches.length,
    matches: top,
    truncatedMatches: matches.length > top.length,
    singleTokenQuery: singleToken,
    source: "OFAC SDN — U.S. Treasury official export (SDN.CSV primary names + ALT.CSV aliases)",
    listEntries: entries.length,
    listFetchedAt: new Date(fetchedAt).toISOString(),
    listStale: stale,
    checkedAt: new Date().toISOString(),
    ...receipt, // carries inputHash, policyVersion, confidence, refusal, refundable
    guidance: hit
      ? "Name matches an OFAC-listed party. This is a screening signal, NOT an identity determination — confirm date of birth, address or registration number against the SDN entry before acting, and consult counsel."
      : top.length
        ? "Only partial name overlap. Common names collide with listed parties routinely; treat as 'needs review', not as a hit."
        : "No name match on the current OFAC SDN list. This screens names only — it does not check addresses, dates of birth, or non-SDN lists (e.g. consolidated/sectoral).",
    disclaimer: "Screening aid. Not legal advice and not a compliance determination.",
  };
}
