/**
 * IBAN validation — the check an agent runs on every payout row.
 *
 * Written deliberately as the shape of endpoint our catalogue lacks. Measured on
 * 2026-08-21: 116 of our 132 indexed resources saw no outside caller at all in
 * 30 days, and the 16 that did average 1.6 calls per payer. Everything we sell
 * answers a question once — "is this token a rug", "is this wallet sanctioned" —
 * and an answer you only need once is a sale you only make once.
 *
 * An IBAN check is the opposite by nature. An agent paying fifty suppliers runs
 * it fifty times, and again next month, because the input changes every row.
 *
 * It is also entirely offline. No upstream API, no key, no rate limit, no
 * provider that can go down and turn a paid answer into a refund — the whole
 * check is arithmetic over a country table. That means it costs us nothing to
 * serve and cannot fail in the ways the rest of the catalogue can.
 *
 * What it does NOT do, stated because the difference matters to anyone about to
 * send money: a structurally valid IBAN is not a real account. Mod-97 proves the
 * digits are self-consistent, which catches transcription errors — the swapped
 * pair, the dropped character, the O typed for a 0. It cannot tell you the
 * account exists, is open, or belongs to who you think. Nothing offline can.
 */

import "server-only";

interface CountrySpec {
  /** Total IBAN length for this country. */
  length: number;
  name: string;
  /** BBAN layout after the 4-char prefix, where known: [bankStart, bankEnd]. */
  bank?: [number, number];
  /** Whether the country is in the SEPA zone (affects which rails can pay it). */
  sepa?: boolean;
}

/**
 * Registry lengths. Sourced from the SWIFT IBAN registry; the length check is
 * what catches most malformed input before the checksum ever runs, and a country
 * we do not know is reported as unknown rather than guessed at.
 */
const COUNTRIES: Record<string, CountrySpec> = {
  AD: { length: 24, name: "Andorra", bank: [0, 4], sepa: true },
  AE: { length: 23, name: "United Arab Emirates", bank: [0, 3] },
  AL: { length: 28, name: "Albania", bank: [0, 3] },
  AT: { length: 20, name: "Austria", bank: [0, 5], sepa: true },
  AZ: { length: 28, name: "Azerbaijan", bank: [0, 4] },
  BA: { length: 20, name: "Bosnia and Herzegovina", bank: [0, 3] },
  BE: { length: 16, name: "Belgium", bank: [0, 3], sepa: true },
  BG: { length: 22, name: "Bulgaria", bank: [0, 4], sepa: true },
  BH: { length: 22, name: "Bahrain", bank: [0, 4] },
  BR: { length: 29, name: "Brazil", bank: [0, 8] },
  BY: { length: 28, name: "Belarus", bank: [0, 4] },
  CH: { length: 21, name: "Switzerland", bank: [0, 5], sepa: true },
  CR: { length: 22, name: "Costa Rica", bank: [0, 4] },
  CY: { length: 28, name: "Cyprus", bank: [0, 3], sepa: true },
  CZ: { length: 24, name: "Czechia", bank: [0, 4], sepa: true },
  DE: { length: 22, name: "Germany", bank: [0, 8], sepa: true },
  DK: { length: 18, name: "Denmark", bank: [0, 4], sepa: true },
  DO: { length: 28, name: "Dominican Republic", bank: [0, 4] },
  EE: { length: 20, name: "Estonia", bank: [0, 2], sepa: true },
  EG: { length: 29, name: "Egypt", bank: [0, 4] },
  ES: { length: 24, name: "Spain", bank: [0, 4], sepa: true },
  FI: { length: 18, name: "Finland", bank: [0, 3], sepa: true },
  FO: { length: 18, name: "Faroe Islands", bank: [0, 4] },
  FR: { length: 27, name: "France", bank: [0, 5], sepa: true },
  GB: { length: 22, name: "United Kingdom", bank: [0, 4], sepa: true },
  GE: { length: 22, name: "Georgia", bank: [0, 2] },
  GI: { length: 23, name: "Gibraltar", bank: [0, 4], sepa: true },
  GL: { length: 18, name: "Greenland", bank: [0, 4] },
  GR: { length: 27, name: "Greece", bank: [0, 3], sepa: true },
  GT: { length: 28, name: "Guatemala", bank: [0, 4] },
  HR: { length: 21, name: "Croatia", bank: [0, 7], sepa: true },
  HU: { length: 28, name: "Hungary", bank: [0, 3], sepa: true },
  IE: { length: 22, name: "Ireland", bank: [0, 4], sepa: true },
  IL: { length: 23, name: "Israel", bank: [0, 3] },
  IS: { length: 26, name: "Iceland", bank: [0, 4], sepa: true },
  IT: { length: 27, name: "Italy", bank: [1, 6], sepa: true },
  JO: { length: 30, name: "Jordan", bank: [0, 4] },
  KW: { length: 30, name: "Kuwait", bank: [0, 4] },
  KZ: { length: 20, name: "Kazakhstan", bank: [0, 3] },
  LB: { length: 28, name: "Lebanon", bank: [0, 4] },
  LC: { length: 32, name: "Saint Lucia", bank: [0, 4] },
  LI: { length: 21, name: "Liechtenstein", bank: [0, 5], sepa: true },
  LT: { length: 20, name: "Lithuania", bank: [0, 5], sepa: true },
  LU: { length: 20, name: "Luxembourg", bank: [0, 3], sepa: true },
  LV: { length: 21, name: "Latvia", bank: [0, 4], sepa: true },
  MC: { length: 27, name: "Monaco", bank: [0, 5], sepa: true },
  MD: { length: 24, name: "Moldova", bank: [0, 2] },
  ME: { length: 22, name: "Montenegro", bank: [0, 3] },
  MK: { length: 19, name: "North Macedonia", bank: [0, 3] },
  MR: { length: 27, name: "Mauritania", bank: [0, 5] },
  MT: { length: 31, name: "Malta", bank: [0, 4], sepa: true },
  MU: { length: 30, name: "Mauritius", bank: [0, 6] },
  NL: { length: 18, name: "Netherlands", bank: [0, 4], sepa: true },
  NO: { length: 15, name: "Norway", bank: [0, 4], sepa: true },
  PK: { length: 24, name: "Pakistan", bank: [0, 4] },
  PL: { length: 28, name: "Poland", bank: [0, 8], sepa: true },
  PS: { length: 29, name: "Palestine", bank: [0, 4] },
  PT: { length: 25, name: "Portugal", bank: [0, 4], sepa: true },
  QA: { length: 29, name: "Qatar", bank: [0, 4] },
  RO: { length: 24, name: "Romania", bank: [0, 4], sepa: true },
  RS: { length: 22, name: "Serbia", bank: [0, 3] },
  SA: { length: 24, name: "Saudi Arabia", bank: [0, 2] },
  SE: { length: 24, name: "Sweden", bank: [0, 3], sepa: true },
  SI: { length: 19, name: "Slovenia", bank: [0, 5], sepa: true },
  SK: { length: 24, name: "Slovakia", bank: [0, 4], sepa: true },
  SM: { length: 27, name: "San Marino", bank: [1, 6], sepa: true },
  TN: { length: 24, name: "Tunisia", bank: [0, 2] },
  TR: { length: 26, name: "Türkiye", bank: [0, 5] },
  UA: { length: 29, name: "Ukraine", bank: [0, 6] },
  VA: { length: 22, name: "Vatican City", sepa: true },
  VG: { length: 24, name: "Virgin Islands, British", bank: [0, 4] },
  XK: { length: 20, name: "Kosovo", bank: [0, 4] },
};

/**
 * ISO 7064 mod-97-10 over the rearranged IBAN.
 *
 * Done in chunks because the number is far past Number.MAX_SAFE_INTEGER once the
 * letters expand to two digits each — a 34-character IBAN becomes a ~60-digit
 * integer. Chunking keeps it exact without BigInt allocation per call.
 */
function mod97(rearranged: string): number {
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i += 7) {
    remainder = Number(`${remainder}${rearranged.slice(i, i + 7)}`) % 97;
  }
  return remainder;
}

/** Letters become their 1-indexed alphabet position + 9 (A=10 … Z=35). */
function expand(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 65 && c <= 90 ? String(c - 55) : ch;
  }
  return out;
}

export interface IbanResult {
  input: string;
  valid: boolean;
  reason: string | null;
  iban: string | null;
  formatted: string | null;
  country: string | null;
  countryName: string | null;
  sepa: boolean | null;
  checkDigits: string | null;
  bankIdentifier: string | null;
  length: number;
  expectedLength: number | null;
  note: string;
  checkedAt: string;
}

/**
 * Validate an IBAN offline: structure, country length, and the mod-97 checksum.
 *
 * Every rejection names which of the three failed, because "invalid" alone tells
 * a caller nothing about whether to fix the input or drop the row.
 */
export function ibanCheck(params: Record<string, string>): IbanResult {
  const raw = (params.iban || params.value || "").trim();
  if (!raw) throw new Error("Provide an IBAN as iban=");

  // Humans and spreadsheets both write IBANs in groups of four.
  const clean = raw.replace(/[\s-]/g, "").toUpperCase();
  const at = new Date().toISOString();
  const base = {
    input: raw,
    length: clean.length,
    note:
      "Offline structural check: country length plus the ISO 7064 mod-97 checksum. A valid IBAN is self-consistent, which catches transcription errors — a swapped pair, a dropped character, an O typed for a zero. It does NOT prove the account exists, is open, or belongs to the person you mean; no offline check can.",
    checkedAt: at,
  };
  const fail = (reason: string, extra: Partial<IbanResult> = {}): IbanResult => ({
    ...base,
    valid: false,
    reason,
    iban: null,
    formatted: null,
    country: null,
    countryName: null,
    sepa: null,
    checkDigits: null,
    bankIdentifier: null,
    expectedLength: null,
    ...extra,
  });

  if (!/^[A-Z0-9]+$/.test(clean)) return fail("Contains characters that are not letters or digits");
  if (clean.length < 15 || clean.length > 34) return fail(`Length ${clean.length} is outside the IBAN range of 15-34`);
  if (!/^[A-Z]{2}[0-9]{2}/.test(clean)) return fail("Must start with a 2-letter country code and 2 check digits");

  const country = clean.slice(0, 2);
  const spec = COUNTRIES[country];
  if (!spec) {
    return fail(`No IBAN country registered for '${country}'`, { country, expectedLength: null });
  }
  if (clean.length !== spec.length) {
    return fail(`${spec.name} IBANs are ${spec.length} characters; this one is ${clean.length}`, {
      country,
      countryName: spec.name,
      expectedLength: spec.length,
    });
  }

  const rearranged = expand(clean.slice(4) + clean.slice(0, 4));
  if (mod97(rearranged) !== 1) {
    return fail("Checksum failed — the digits are not self-consistent, so something was mistyped", {
      country,
      countryName: spec.name,
      expectedLength: spec.length,
      checkDigits: clean.slice(2, 4),
    });
  }

  const bban = clean.slice(4);
  const bank = spec.bank ? bban.slice(spec.bank[0], spec.bank[1]) : null;

  return {
    ...base,
    valid: true,
    reason: null,
    iban: clean,
    formatted: (clean.match(/.{1,4}/g) ?? []).join(" "),
    country,
    countryName: spec.name,
    sepa: Boolean(spec.sepa),
    checkDigits: clean.slice(2, 4),
    bankIdentifier: bank,
    expectedLength: spec.length,
  };
}
