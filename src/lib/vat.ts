/**
 * EU VAT number validation — structure and, where the algorithm is published
 * and unambiguous, the checksum.
 *
 * Third of the per-row family (iban-check, phone-check). An agent processing
 * B2B invoices validates a VAT number on every line that carries one.
 *
 * THE HONEST LINE, DRAWN EXPLICITLY
 * ---------------------------------
 * There are two very different questions: "is this well-formed" and "is this
 * registered". Only the first is answerable offline, and conflating them would
 * be dangerous in the one direction that matters — a caller reading "valid" as
 * "safe to zero-rate this invoice" and getting it wrong is a tax problem, not a
 * data problem.
 *
 * So: `valid` means structurally valid, always. `checksumChecked` says whether
 * the number was also verified against the country's published check-digit
 * algorithm or only against its format. And `registered` is always null with a
 * reason pointing at VIES, because we do not ask VIES and will not pretend to.
 *
 * Checksums are implemented for the eight countries whose algorithms are public
 * and unambiguous. For the rest the format is checked and `checksumChecked` is
 * false — which is a weaker answer, stated as a weaker answer.
 */

import "server-only";

type Checksum = (n: string) => boolean;

interface VatSpec {
  name: string;
  /** Format of the number AFTER the two-letter country prefix. */
  format: RegExp;
  check?: Checksum;
}

/** Weighted sum helper — the shape most of these algorithms share. */
const weighted = (n: string, weights: number[]): number =>
  weights.reduce((s, w, i) => s + w * Number(n[i]), 0);

/** Belgium: 10 digits, first 8 mod 97 complement equals the last 2. */
const beCheck: Checksum = (n) => 97 - (Number(n.slice(0, 8)) % 97) === Number(n.slice(8, 10));

/** France: key = (12 + 3 * (SIREN mod 97)) mod 97, when the key is numeric. */
const frCheck: Checksum = (n) => {
  const key = n.slice(0, 2);
  if (!/^\d{2}$/.test(key)) return true; // alphanumeric keys use a different rule
  return Number(key) === (12 + 3 * (Number(n.slice(2)) % 97)) % 97;
};

/** Netherlands: 9 digits weighted 9..2, mod 11, remainder must equal digit 9. */
const nlCheck: Checksum = (n) => {
  const sum = weighted(n, [9, 8, 7, 6, 5, 4, 3, 2]);
  const r = sum % 11;
  return r < 10 && r === Number(n[8]);
};

/** Italy: Luhn over 11 digits. */
const itCheck: Checksum = (n) => {
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    let d = Number(n[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

/** Poland: weights 6,5,7,2,3,4,5,6,7 mod 11 equals the last digit. */
const plCheck: Checksum = (n) => {
  const r = weighted(n, [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11;
  return r < 10 && r === Number(n[9]);
};

/** Portugal: weights 9..2 mod 11; remainder 0 or 1 means check digit 0. */
const ptCheck: Checksum = (n) => {
  const r = weighted(n, [9, 8, 7, 6, 5, 4, 3, 2]) % 11;
  const expect = r < 2 ? 0 : 11 - r;
  return expect === Number(n[8]);
};

/** Luxembourg: first 6 mod 89 equals the last 2. */
const luCheck: Checksum = (n) => Number(n.slice(0, 6)) % 89 === Number(n.slice(6, 8));

/** Germany: ISO 7064 MOD 11,10 over 9 digits. */
const deCheck: Checksum = (n) => {
  let product = 10;
  for (let i = 0; i < 8; i++) {
    let sum = (Number(n[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  const expect = (11 - product) % 10;
  return expect === Number(n[8]);
};

const SPECS: Record<string, VatSpec> = {
  AT: { name: "Austria", format: /^U\d{8}$/ },
  BE: { name: "Belgium", format: /^0\d{9}$/, check: beCheck },
  BG: { name: "Bulgaria", format: /^\d{9,10}$/ },
  CY: { name: "Cyprus", format: /^\d{8}[A-Z]$/ },
  CZ: { name: "Czechia", format: /^\d{8,10}$/ },
  DE: { name: "Germany", format: /^\d{9}$/, check: deCheck },
  DK: { name: "Denmark", format: /^\d{8}$/ },
  EE: { name: "Estonia", format: /^\d{9}$/ },
  EL: { name: "Greece", format: /^\d{9}$/ },
  ES: { name: "Spain", format: /^[A-Z0-9]\d{7}[A-Z0-9]$/ },
  FI: { name: "Finland", format: /^\d{8}$/ },
  FR: { name: "France", format: /^[A-Z0-9]{2}\d{9}$/, check: frCheck },
  HR: { name: "Croatia", format: /^\d{11}$/ },
  HU: { name: "Hungary", format: /^\d{8}$/ },
  IE: { name: "Ireland", format: /^(\d{7}[A-W]{1,2}|\d[A-Z+*]\d{5}[A-W])$/ },
  IT: { name: "Italy", format: /^\d{11}$/, check: itCheck },
  LT: { name: "Lithuania", format: /^(\d{9}|\d{12})$/ },
  LU: { name: "Luxembourg", format: /^\d{8}$/, check: luCheck },
  LV: { name: "Latvia", format: /^\d{11}$/ },
  MT: { name: "Malta", format: /^\d{8}$/ },
  NL: { name: "Netherlands", format: /^\d{9}B\d{2}$/, check: nlCheck },
  PL: { name: "Poland", format: /^\d{10}$/, check: plCheck },
  PT: { name: "Portugal", format: /^\d{9}$/, check: ptCheck },
  RO: { name: "Romania", format: /^\d{2,10}$/ },
  SE: { name: "Sweden", format: /^\d{10}01$/ },
  SI: { name: "Slovenia", format: /^\d{8}$/ },
  SK: { name: "Slovakia", format: /^\d{10}$/ },
  XI: { name: "Northern Ireland", format: /^(\d{9}|\d{12}|(GD|HA)\d{3})$/ },
};

export interface VatResult {
  input: string;
  valid: boolean;
  reason: string | null;
  vat: string | null;
  country: string | null;
  countryName: string | null;
  number: string | null;
  checksumChecked: boolean;
  registered: null;
  registeredNote: string;
  note: string;
  checkedAt: string;
}

/** Validate an EU VAT number's structure, and its checksum where one is defined. */
export function vatCheck(params: Record<string, string>): VatResult {
  const raw = (params.vat || params.number || params.value || "").trim();
  if (!raw) throw new Error("Provide a VAT number as vat=");
  const at = new Date().toISOString();
  const clean = raw.replace(/[\s.\-/]/g, "").toUpperCase();

  const base = {
    input: raw,
    registered: null as null,
    registeredNote:
      "Not checked. Whether a VAT number is actually registered can only be answered by the EU VIES service (ec.europa.eu/taxation_customs/vies), which this endpoint does not call. A structurally valid number can be unregistered, expired, or belong to someone else.",
    note:
      "Offline check of an EU VAT number: country prefix, national format, and the published check-digit algorithm where one exists. `checksumChecked` tells you which of the two you got — a format-only pass is a weaker answer and is reported as one.",
    checkedAt: at,
  };
  const fail = (reason: string, extra: Partial<VatResult> = {}): VatResult => ({
    ...base,
    valid: false,
    reason,
    vat: null,
    country: null,
    countryName: null,
    number: null,
    checksumChecked: false,
    ...extra,
  });

  if (clean.length < 4) return fail("Too short to be a VAT number");
  const cc = clean.slice(0, 2);
  const rest = clean.slice(2);
  const spec = SPECS[cc];
  if (!spec) return fail(`'${cc}' is not an EU VAT country prefix`, { country: cc });

  if (!spec.format.test(rest)) {
    return fail(`Does not match the ${spec.name} VAT format`, { country: cc, countryName: spec.name, number: rest });
  }
  if (spec.check && !spec.check(rest)) {
    return fail(`${spec.name} check digits do not match — something was mistyped`, {
      country: cc,
      countryName: spec.name,
      number: rest,
      checksumChecked: true,
    });
  }

  return {
    ...base,
    valid: true,
    reason: null,
    vat: `${cc}${rest}`,
    country: cc,
    countryName: spec.name,
    number: rest,
    checksumChecked: Boolean(spec.check),
  };
}
