/**
 * Phone number normalisation — the other check that runs once per row.
 *
 * Same reasoning as iban-check: an agent cleaning a contact list, sending
 * verification codes or de-duplicating a CRM runs this per record, not once.
 * Offline, so no upstream to rate-limit us and no provider whose outage turns a
 * paid answer into a refund.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * Full libphonenumber carries per-country prefix metadata for every operator in
 * the world and is revised constantly. Shipping a hand-copied fraction of that
 * and calling the result "mobile" would be exactly the failure this codebase
 * keeps fixing: a confident answer produced by not knowing.
 *
 * So the line is drawn explicitly. Country and E.164 normalisation are computed
 * everywhere the calling code is known. Length is checked where the national
 * numbering plan is stable enough to assert. Line type is reported ONLY for
 * countries whose mobile ranges are unambiguous and stable, and is `null`
 * elsewhere with a reason — never guessed.
 */

import "server-only";

interface Plan {
  cc: string;
  name: string;
  /** Valid national-number lengths (excluding the country code). */
  lengths: number[];
  /** National trunk prefix stripped before matching, if the country uses one. */
  trunk?: string;
  /** Leading digits that identify a mobile line, where this is unambiguous. */
  mobile?: RegExp;
  /** Leading digits that identify a fixed line, where unambiguous. */
  fixed?: RegExp;
}

/**
 * Numbering plans. Only countries whose national length rules are stable are
 * listed; anything else resolves the country from the calling code and says the
 * length was not checked rather than inventing a rule.
 */
const PLANS: Plan[] = [
  { cc: "1", name: "United States / Canada", lengths: [10], trunk: "1" },
  { cc: "7", name: "Russia / Kazakhstan", lengths: [10], trunk: "8", mobile: /^9/ },
  { cc: "20", name: "Egypt", lengths: [10], trunk: "0", mobile: /^1/ },
  { cc: "27", name: "South Africa", lengths: [9], trunk: "0", mobile: /^(6|7|8)/ },
  { cc: "31", name: "Netherlands", lengths: [9], trunk: "0", mobile: /^6/ },
  { cc: "32", name: "Belgium", lengths: [8, 9], trunk: "0", mobile: /^4[5-9]/ },
  { cc: "33", name: "France", lengths: [9], trunk: "0", mobile: /^[67]/, fixed: /^[1-5]/ },
  { cc: "34", name: "Spain", lengths: [9], mobile: /^[67]/, fixed: /^[89]/ },
  { cc: "39", name: "Italy", lengths: [9, 10], mobile: /^3/, fixed: /^0/ },
  { cc: "40", name: "Romania", lengths: [9], trunk: "0", mobile: /^7/ },
  { cc: "41", name: "Switzerland", lengths: [9], trunk: "0", mobile: /^7[5-9]/ },
  { cc: "43", name: "Austria", lengths: [10, 11, 12, 13], trunk: "0" },
  { cc: "44", name: "United Kingdom", lengths: [10], trunk: "0", mobile: /^7[1-9]/, fixed: /^[12]/ },
  { cc: "45", name: "Denmark", lengths: [8] },
  { cc: "46", name: "Sweden", lengths: [7, 8, 9], trunk: "0", mobile: /^7[02369]/ },
  { cc: "47", name: "Norway", lengths: [8], mobile: /^[49]/ },
  { cc: "48", name: "Poland", lengths: [9], mobile: /^(45|5|6|7|88)/ },
  { cc: "49", name: "Germany", lengths: [10, 11], trunk: "0", mobile: /^1[5-7]/ },
  { cc: "52", name: "Mexico", lengths: [10] },
  { cc: "55", name: "Brazil", lengths: [10, 11], trunk: "0" },
  { cc: "61", name: "Australia", lengths: [9], trunk: "0", mobile: /^4/ },
  { cc: "65", name: "Singapore", lengths: [8], mobile: /^[89]/ },
  { cc: "81", name: "Japan", lengths: [9, 10], trunk: "0", mobile: /^[78]0/ },
  { cc: "82", name: "South Korea", lengths: [9, 10], trunk: "0", mobile: /^10/ },
  { cc: "86", name: "China", lengths: [11], mobile: /^1[3-9]/ },
  { cc: "90", name: "Türkiye", lengths: [10], trunk: "0", mobile: /^5/, fixed: /^[2-4]/ },
  { cc: "91", name: "India", lengths: [10], trunk: "0", mobile: /^[6-9]/ },
  { cc: "351", name: "Portugal", lengths: [9], mobile: /^9/, fixed: /^2/ },
  { cc: "352", name: "Luxembourg", lengths: [6, 7, 8, 9] },
  { cc: "353", name: "Ireland", lengths: [9], trunk: "0", mobile: /^8[35-9]/ },
  { cc: "358", name: "Finland", lengths: [9, 10], trunk: "0", mobile: /^4|^50/ },
  { cc: "359", name: "Bulgaria", lengths: [8, 9], trunk: "0", mobile: /^8[7-9]/ },
  { cc: "370", name: "Lithuania", lengths: [8], trunk: "8", mobile: /^6/ },
  { cc: "371", name: "Latvia", lengths: [8], mobile: /^2/ },
  { cc: "372", name: "Estonia", lengths: [7, 8], mobile: /^5/ },
  { cc: "380", name: "Ukraine", lengths: [9], trunk: "0", mobile: /^(39|50|6[3-8]|7[3-5]|9[1-9])/ },
  { cc: "385", name: "Croatia", lengths: [8, 9], trunk: "0", mobile: /^9/ },
  { cc: "420", name: "Czechia", lengths: [9], mobile: /^[67]/ },
  { cc: "421", name: "Slovakia", lengths: [9], trunk: "0", mobile: /^9/ },
  { cc: "971", name: "United Arab Emirates", lengths: [9], trunk: "0", mobile: /^5/ },
  { cc: "972", name: "Israel", lengths: [9], trunk: "0", mobile: /^5/ },
  { cc: "966", name: "Saudi Arabia", lengths: [9], trunk: "0", mobile: /^5/ },
];

/** Longest calling code first, so +1 never shadows +1xx and +3 never +351. */
const SORTED = [...PLANS].sort((a, b) => b.cc.length - a.cc.length);

export interface PhoneResult {
  input: string;
  valid: boolean;
  reason: string | null;
  e164: string | null;
  countryCode: string | null;
  country: string | null;
  nationalNumber: string | null;
  lengthChecked: boolean;
  lineType: "mobile" | "fixed" | null;
  lineTypeReason: string;
  note: string;
  checkedAt: string;
}

/**
 * Normalise a phone number to E.164 and check what can honestly be checked.
 *
 * `country` is an optional ISO-ish hint used only when the input has no `+`,
 * because a bare national number is ambiguous without one.
 */
export function phoneCheck(params: Record<string, string>): PhoneResult {
  const raw = (params.phone || params.number || params.value || "").trim();
  if (!raw) throw new Error("Provide a phone number as phone=");
  const at = new Date().toISOString();

  const note =
    "Offline normalisation: country calling code, E.164 form, and national length where the numbering plan is stable. Line type is reported only for countries whose mobile ranges are unambiguous, and is null elsewhere rather than guessed. This does NOT check that the number is assigned, active, or reachable — no offline check can.";
  const base = { input: raw, note, checkedAt: at };
  const fail = (reason: string, extra: Partial<PhoneResult> = {}): PhoneResult => ({
    ...base,
    valid: false,
    reason,
    e164: null,
    countryCode: null,
    country: null,
    nationalNumber: null,
    lengthChecked: false,
    lineType: null,
    lineTypeReason: "not determined — the number did not validate",
    ...extra,
  });

  // Keep a leading +, drop everything a human might type around the digits.
  const hasPlus = /^\s*\+/.test(raw) || /^00/.test(raw.replace(/[\s()\-.]/g, ""));
  let digits = raw.replace(/[^\d]/g, "");
  if (/^00/.test(digits)) digits = digits.slice(2); // 00 is the international prefix
  if (!digits) return fail("No digits in the input");
  if (digits.length < 6) return fail(`Only ${digits.length} digits — too short to be a phone number`);
  if (digits.length > 15) return fail(`${digits.length} digits — E.164 allows at most 15`);

  // Country: from the number itself when it is international, else from the hint.
  let plan: Plan | undefined;
  let national = "";
  if (hasPlus) {
    plan = SORTED.find((p) => digits.startsWith(p.cc));
    if (!plan) {
      const cc = digits.slice(0, 3);
      return fail(`No numbering plan known for calling code +${cc.slice(0, 2)}…`, { countryCode: null });
    }
    national = digits.slice(plan.cc.length);
  } else {
    const hint = (params.country || "").trim().replace(/^\+/, "");
    if (!hint) {
      return fail("A number without a leading + is ambiguous — pass it as +<country><number>, or add country=<calling code>");
    }
    plan = SORTED.find((p) => p.cc === hint.replace(/[^\d]/g, ""));
    if (!plan) return fail(`No numbering plan known for country=${hint}`);
    national = digits;
  }

  // Strip the national trunk prefix, which people include out of habit.
  if (plan.trunk && national.startsWith(plan.trunk) && national.length > plan.lengths[0]) {
    national = national.slice(plan.trunk.length);
  }

  const lengthOk = plan.lengths.includes(national.length);
  if (!lengthOk) {
    return fail(
      `${plan.name} national numbers are ${plan.lengths.join(" or ")} digits; this one is ${national.length}`,
      { countryCode: `+${plan.cc}`, country: plan.name, nationalNumber: national, lengthChecked: true },
    );
  }

  // Line type only where the ranges are unambiguous. Everywhere else: null.
  let lineType: "mobile" | "fixed" | null = null;
  let lineTypeReason = `not determined — ${plan.name} mobile and fixed ranges overlap or are not stable enough to assert offline`;
  if (plan.mobile?.test(national)) {
    lineType = "mobile";
    lineTypeReason = "mobile — the national number falls in an unambiguous mobile range";
  } else if (plan.fixed?.test(national)) {
    lineType = "fixed";
    lineTypeReason = "fixed line — the national number falls in an unambiguous geographic range";
  } else if (plan.mobile || plan.fixed) {
    lineTypeReason = `not determined — the number is valid for ${plan.name} but outside the ranges we can assert`;
  }

  return {
    ...base,
    valid: true,
    reason: null,
    e164: `+${plan.cc}${national}`,
    countryCode: `+${plan.cc}`,
    country: plan.name,
    nationalNumber: national,
    lengthChecked: true,
    lineType,
    lineTypeReason,
  };
}
