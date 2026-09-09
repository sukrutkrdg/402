/**
 * Per-row bank / card / tax identifiers — the same shape as iban-check.
 *
 * Offline structure first. Where a live registry would be required to claim
 * "this bank exists", the answer says so instead of inventing a hit.
 */

import "server-only";

const at = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// BIC / SWIFT
// ---------------------------------------------------------------------------

/** ISO 9362 structure: AAAABBCC[DDD] — bank(4) country(2) location(2) [branch(3)]. */
export function bicCheck(params: Record<string, string>) {
  const raw = (params.bic || params.swift || params.value || "").trim();
  if (!raw) throw new Error("Provide a BIC/SWIFT code as bic=");
  const clean = raw.replace(/[\s-]/g, "").toUpperCase();
  const base = {
    input: raw,
    note:
      "Offline ISO 9362 structure check. A well-formed BIC is not proof the bank is live or that a payment to it will clear.",
    checkedAt: at(),
  };
  if (!/^[A-Z0-9]+$/.test(clean)) {
    return { ...base, valid: false, reason: "Contains characters that are not letters or digits", bic: null };
  }
  if (clean.length !== 8 && clean.length !== 11) {
    return {
      ...base,
      valid: false,
      reason: `BIC length must be 8 or 11; this one is ${clean.length}`,
      bic: null,
    };
  }
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(clean)) {
    return { ...base, valid: false, reason: "Does not match AAAABBCC[XXX] layout", bic: null };
  }
  const bankCode = clean.slice(0, 4);
  const country = clean.slice(4, 6);
  const location = clean.slice(6, 8);
  const branch = clean.length === 11 ? clean.slice(8) : null;
  return {
    ...base,
    valid: true,
    reason: null,
    bic: clean,
    bankCode,
    country,
    location,
    branch,
    isHeadOffice: branch === null || branch === "XXX",
    testBic: location[1] === "0",
  };
}

// ---------------------------------------------------------------------------
// Card BIN (first 6–8 digits) — IIN structure only
// ---------------------------------------------------------------------------

const SCHEMES: Array<{ name: string; test: (n: string) => boolean }> = [
  { name: "Visa", test: (n) => n.startsWith("4") },
  { name: "Mastercard", test: (n) => /^5[1-5]/.test(n) || /^2[2-7]/.test(n) },
  { name: "American Express", test: (n) => /^3[47]/.test(n) },
  { name: "Discover", test: (n) => /^6011|^65|^64[4-9]|^622/.test(n) },
  { name: "Diners Club", test: (n) => /^3(0[0-5]|[68])/.test(n) },
  { name: "JCB", test: (n) => /^35/.test(n) },
  { name: "UnionPay", test: (n) => /^62/.test(n) },
  { name: "Maestro", test: (n) => /^(50|5[6-9]|6)/.test(n) },
];

export function binCheck(params: Record<string, string>) {
  const raw = (params.bin || params.pan || params.value || "").trim();
  if (!raw) throw new Error("Provide card BIN digits as bin= (6–8 digits, never a full PAN)");
  const digits = raw.replace(/[\s-]/g, "");
  const base = {
    input: raw,
    note:
      "Offline Issuer Identification Number structure. Does not look the BIN up in a live registry and never accepts a full PAN — send 6 to 8 digits only.",
    checkedAt: at(),
  };
  if (!/^\d+$/.test(digits)) {
    return { ...base, valid: false, reason: "BIN must be digits only", bin: null };
  }
  if (digits.length > 8) {
    return {
      ...base,
      valid: false,
      reason: `Refusing ${digits.length} digits — that looks like a full PAN. Send the first 6–8 only`,
      bin: null,
    };
  }
  if (digits.length < 6) {
    return { ...base, valid: false, reason: `BIN must be at least 6 digits; got ${digits.length}`, bin: null };
  }
  const scheme = SCHEMES.find((s) => s.test(digits))?.name ?? null;
  return {
    ...base,
    valid: true,
    reason: null,
    bin: digits.slice(0, 8),
    length: digits.length,
    scheme,
    schemeKnown: Boolean(scheme),
  };
}

// ---------------------------------------------------------------------------
// SEPA Creditor Identifier
// ---------------------------------------------------------------------------

/** ISO 7064 mod-97 over alphabetic expansion — same family as IBAN. */
function mod97(s: string): number {
  let rem = 0;
  for (let i = 0; i < s.length; i += 7) {
    rem = Number(`${rem}${s.slice(i, i + 7)}`) % 97;
  }
  return rem;
}

function expand(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 65 && c <= 90 ? String(c - 55) : ch;
  }
  return out;
}

export function sepaCreditorCheck(params: Record<string, string>) {
  const raw = (params.creditorId || params.id || params.value || "").trim();
  if (!raw) throw new Error("Provide a SEPA Creditor Identifier as creditorId=");
  const clean = raw.replace(/[\s-]/g, "").toUpperCase();
  const base = {
    input: raw,
    note:
      "Offline SEPA Creditor Identifier structure (country + check + business code + national id). Does not prove the creditor is registered with a scheme manager.",
    checkedAt: at(),
  };
  if (clean.length < 8 || clean.length > 35) {
    return { ...base, valid: false, reason: `Length ${clean.length} is outside 8–35`, creditorId: null };
  }
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{3}.+/.test(clean)) {
    return {
      ...base,
      valid: false,
      reason: "Must start with country(2) + check digits(2) + creditor business code(3)",
      creditorId: null,
    };
  }
  const country = clean.slice(0, 2);
  const check = clean.slice(2, 4);
  const businessCode = clean.slice(4, 7);
  const nationalId = clean.slice(7);
  // Check digits: rearrange like IBAN over country + '00' + national part without business code… 
  // Spec: calculate over country + checkPlaceholder + national identifier (business code excluded from checksum in many implementations).
  // Practical check used by EU schemes: mod-97 of (nationalId + country + check) after alpha expand equals 1 when check is correct.
  const rearranged = expand(nationalId + country + check);
  const ok = /^\d{2}$/.test(check) && mod97(rearranged) === 1;
  if (!ok) {
    return {
      ...base,
      valid: false,
      reason: "Checksum failed — digits are not self-consistent",
      creditorId: null,
      country,
      businessCode,
      nationalId,
    };
  }
  return {
    ...base,
    valid: true,
    reason: null,
    creditorId: clean,
    country,
    checkDigits: check,
    businessCode,
    nationalId,
  };
}

// ---------------------------------------------------------------------------
// Tax / customs identifiers (format by country)
// ---------------------------------------------------------------------------

type TaxSpec = { name: string; format: RegExp; hint: string };

const TAX_SPECS: Record<string, TaxSpec> = {
  EORI: {
    name: "EU EORI",
    format: /^[A-Z]{2}[A-Z0-9]{1,15}$/,
    hint: "Country prefix + up to 15 alphanumerics (often the VAT stem)",
  },
  EIN: {
    name: "US EIN",
    format: /^\d{2}-?\d{7}$/,
    hint: "XX-XXXXXXX",
  },
  SSN: {
    name: "US SSN (format only)",
    format: /^(?!000|666|9\d\d)\d{3}-?(?!00)\d{2}-?(?!0000)\d{4}$/,
    hint: "AAA-GG-SSSS with invalid-area exclusions",
  },
  NINO: {
    name: "UK National Insurance",
    format: /^[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]$/,
    hint: "Two letters, six digits, one letter A–D",
  },
  ABN: {
    name: "Australian Business Number",
    format: /^\d{11}$/,
    hint: "11 digits with ABR checksum",
  },
  TR_VKN: {
    name: "Türkiye vergi kimlik no",
    format: /^\d{10}$/,
    hint: "10-digit VKN",
  },
  TR_TCKN: {
    name: "Türkiye TCKN",
    format: /^\d{11}$/,
    hint: "11-digit national ID with checksum",
  },
  CA_BN: {
    name: "Canada Business Number",
    format: /^\d{9}$/,
    hint: "9-digit BN root",
  },
};

function abnChecksum(n: string): boolean {
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const digits = n.split("").map(Number);
  digits[0] -= 1;
  const sum = digits.reduce((s, d, i) => s + d * w[i], 0);
  return sum % 89 === 0;
}

function tcknChecksum(n: string): boolean {
  if (n[0] === "0") return false;
  const d = n.split("").map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8];
  const even = d[1] + d[3] + d[5] + d[7];
  const d10 = (odd * 7 - even) % 10;
  const d11 = d.slice(0, 10).reduce((s, x) => s + x, 0) % 10;
  return d[9] === ((d10 % 10) + 10) % 10 && d[10] === d11;
}

export function taxIdCheck(params: Record<string, string>) {
  const kind = (params.kind || params.type || "EORI").trim().toUpperCase().replace(/[-\s]/g, "_");
  const raw = (params.value || params.id || params.taxId || "").trim();
  if (!raw) throw new Error("Provide value= and kind= (EORI, EIN, SSN, NINO, ABN, TR_VKN, TR_TCKN, CA_BN)");
  const aliases: Record<string, string> = {
    EORI: "EORI",
    EIN: "EIN",
    SSN: "SSN",
    NINO: "NINO",
    NI: "NINO",
    ABN: "ABN",
    VKN: "TR_VKN",
    TR_VKN: "TR_VKN",
    TCKN: "TR_TCKN",
    TR_TCKN: "TR_TCKN",
    BN: "CA_BN",
    CA_BN: "CA_BN",
  };
  const key = aliases[kind];
  if (!key || !TAX_SPECS[key]) {
    throw new Error(`Unknown kind '${kind}'. Use: ${Object.keys(TAX_SPECS).join(", ")}`);
  }
  const spec = TAX_SPECS[key];
  const clean = raw.replace(/\s/g, "").toUpperCase();
  const base = {
    input: raw,
    kind: key,
    kindName: spec.name,
    hint: spec.hint,
    note:
      "Offline format (and checksum where published). Not a registry lookup — a well-formed id is not proof of registration.",
    checkedAt: at(),
  };
  const normalised =
    key === "EIN" ? clean.replace(/^(\d{2})(\d{7})$/, "$1-$2") :
    key === "SSN" ? clean.replace(/^(\d{3})(\d{2})(\d{4})$/, "$1-$2-$3") :
    clean;

  if (!spec.format.test(clean) && !spec.format.test(normalised)) {
    return { ...base, valid: false, reason: `Does not match ${spec.name} format (${spec.hint})`, value: null, checksumChecked: false };
  }

  let checksumChecked = false;
  let checksumOk: boolean | null = null;
  if (key === "ABN") {
    checksumChecked = true;
    checksumOk = abnChecksum(clean.replace(/\D/g, ""));
    if (!checksumOk) return { ...base, valid: false, reason: "ABN checksum failed", value: null, checksumChecked, checksumOk };
  }
  if (key === "TR_TCKN") {
    checksumChecked = true;
    checksumOk = tcknChecksum(clean);
    if (!checksumOk) return { ...base, valid: false, reason: "TCKN checksum failed", value: null, checksumChecked, checksumOk };
  }

  return {
    ...base,
    valid: true,
    reason: null,
    value: key === "EIN" || key === "SSN" ? normalised : clean,
    checksumChecked,
    checksumOk,
  };
}
