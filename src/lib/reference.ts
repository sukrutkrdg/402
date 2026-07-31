/**
 * Reference primitives — currency, calendar, inflation.
 *
 * WHY THESE THREE: they are the unglamorous arithmetic every business agent hits
 * and none of them can do alone. An invoice is in one currency and the ledger in
 * another; a payment term is "net 30 business days" in a country whose holidays
 * the agent does not know; a contract written in 2019 has to be compared with
 * today's money. The sellers with the widest reach on this network earn it with
 * exactly this kind of endpoint, at a fifth of a cent, because agents call them
 * constantly. Every source here is a public institution's own feed: no key, no
 * quota, no upstream bill.
 *
 * The honesty problems in this file are all about DATES. A rate for a Sunday
 * does not exist, a holiday calendar is national but not regional, and inflation
 * is published a year late. Each answer says which date it actually used.
 */

import "server-only";

const TIMEOUT_MS = 8000;
const UA = "x402-bazaar/1.0 (+https://402.com.tr)";

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Source responded ${res.status}`);
  return res.json();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CCY = /^[A-Za-z]{3}$/;

// ---------------------------------------------------------------------------
// FX
// ---------------------------------------------------------------------------

/**
 * ECB reference rates, straight from the ECB.
 *
 * The convenience proxy we started on is a single volunteer-run host that
 * throttles under repeated calls — it timed out twice in one test run. Rates are
 * a published file, so we read the publisher's own XML and keep the proxy only
 * as a fallback. Base is always EUR; cross rates are derived from it.
 */
const ECB_DAILY = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const ECB_90D = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
const rateCache = new Map<string, { at: number; date: string; rates: Record<string, number> }>();
const RATE_TTL_MS = 60 * 60 * 1000;

async function ecbRates(date: string | null): Promise<{ date: string; rates: Record<string, number> } | null> {
  const key = date || "latest";
  const hit = rateCache.get(key);
  if (hit && Date.now() - hit.at < RATE_TTL_MS) return { date: hit.date, rates: hit.rates };
  let xml: string;
  try {
    const res = await fetch(date ? ECB_90D : ECB_DAILY, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  }
  // <Cube time="2026-07-30"> <Cube currency="USD" rate="1.1476"/> …
  const days = xml.split(/<Cube\s+time="/).slice(1);
  for (const chunk of days) {
    const day = chunk.slice(0, 10);
    if (date && day > date) continue; // walk back to the requested date or earlier
    const rates: Record<string, number> = { EUR: 1 };
    for (const m of chunk.matchAll(/currency="([A-Z]{3})"\s+rate="([\d.]+)"/g)) {
      rates[m[1]] = Number(m[2]);
    }
    if (Object.keys(rates).length < 5) continue;
    rateCache.set(key, { at: Date.now(), date: day, rates });
    return { date: day, rates };
  }
  return null;
}

export async function fxConvert(params: Record<string, string>) {
  const from = (params.from || "").trim().toUpperCase();
  const toRaw = (params.to || "").trim().toUpperCase();
  if (!CCY.test(from)) throw new Error("Missing or invalid 'from' — a 3-letter currency code, e.g. USD");
  const targets = toRaw.split(",").map((t) => t.trim()).filter(Boolean);
  if (!targets.length || !targets.every((t) => CCY.test(t))) {
    throw new Error("Missing or invalid 'to' — one or more 3-letter currency codes, e.g. EUR or EUR,TRY");
  }
  if (targets.length > 10) throw new Error("Too many target currencies (max 10)");
  const amount = params.amount === undefined || params.amount === "" ? 1 : Number(params.amount);
  if (!Number.isFinite(amount)) throw new Error("'amount' must be a number");
  const date = (params.date || "").trim();
  if (date && !ISO_DATE.test(date)) throw new Error("'date' must be YYYY-MM-DD");

  let converted: Record<string, number> = {};
  let rateDate: string | null = null;
  let source = "European Central Bank daily reference rates (ecb.europa.eu)";

  const ecb = await ecbRates(date || null);
  if (ecb && ecb.rates[from]) {
    const missing = targets.filter((t) => !ecb.rates[t]);
    if (!missing.length) {
      rateDate = ecb.date;
      for (const t of targets) converted[t] = Number(((amount * ecb.rates[t]) / ecb.rates[from]).toFixed(6));
    }
  }

  if (!rateDate) {
    // Either the ECB file did not cover this date/currency, or it did not answer.
    const url = `https://api.frankfurter.app/${date || "latest"}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(targets.join(","))}&amount=${encodeURIComponent(String(amount))}`;
    let data: { date?: string; rates?: Record<string, number> };
    try {
      data = (await getJson(url)) as typeof data;
    } catch (e) {
      const err = new Error(`Exchange-rate source unavailable: ${(e as Error).message}`);
      (err as Error & { status?: number }).status = 502;
      throw err;
    }
    if (!data.rates || !Object.keys(data.rates).length) {
      throw new Error(`No rate published for ${from} → ${targets.join(",")}${date ? ` on ${date}` : ""}`);
    }
    converted = data.rates;
    rateDate = data.date ?? null;
    source = "European Central Bank reference rates (via the Frankfurter mirror)";
  }

  const data = { rates: converted };
  // The ECB publishes on TARGET business days only. Ask for a Sunday and the
  // source quietly answers with Friday's rate — quietly is the problem, so the
  // difference is reported rather than absorbed.
  const usedEarlierRate = Boolean(date && rateDate && rateDate !== date);

  return {
    amount,
    from,
    to: targets,
    converted: data.rates,
    rate: Object.fromEntries(Object.entries(data.rates).map(([k, v]) => [k, amount === 0 ? 0 : v / amount])),
    requestedDate: date || null,
    rateDate,
    usedEarlierRate,
    source,
    checkedAt: new Date().toISOString(),
    guidance: usedEarlierRate
      ? `No rate exists for ${date} — the ECB publishes on business days only, so this is the rate from ${rateDate}.`
      : "Rate as published by the ECB for the date shown.",
    method:
      "European Central Bank daily reference rates, read from the ECB's own published file (a mirror is used only if the ECB does not answer). Cross rates are derived through EUR. Published once per TARGET business day around 16:00 CET; dated requests reach back 90 days.",
    disclaimer:
      "Reference rates, not tradable quotes: a bank or card network will not fill at this price. Use for accounting, reporting and comparison, not for pricing a trade.",
  };
}

// ---------------------------------------------------------------------------
// Business days
// ---------------------------------------------------------------------------

/**
 * Countries whose weekend is not Saturday+Sunday. Everywhere else defaults to
 * 6,0 (Sat,Sun). Getting this wrong silently shifts every due date in the
 * country by two days, which is worse than refusing to answer.
 */
const WEEKENDS: Record<string, number[]> = {
  AE: [5, 6], BH: [5, 6], DZ: [5, 6], EG: [5, 6], IL: [5, 6], IQ: [5, 6], IR: [5, 5],
  JO: [5, 6], KW: [5, 6], LY: [5, 6], OM: [5, 6], PS: [5, 6], QA: [5, 6], SA: [5, 6],
  SD: [5, 6], SY: [5, 6], YE: [5, 6], AF: [4, 5], BD: [5, 6], MV: [5, 6], NP: [6],
};

interface Holiday {
  date: string;
  localName: string;
  name: string;
  global: boolean;
  counties: string[] | null;
}

async function holidaysFor(country: string, years: number[]): Promise<Holiday[]> {
  const all: Holiday[] = [];
  for (const y of years) {
    const list = (await getJson(`https://date.nager.at/api/v3/PublicHolidays/${y}/${country}`)) as Holiday[];
    if (Array.isArray(list)) all.push(...list);
  }
  return all;
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function isWeekend(iso: string, country: string): boolean {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return (WEEKENDS[country] ?? [6, 0]).includes(dow);
}

export async function businessDays(params: Record<string, string>) {
  const country = (params.country || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("Missing or invalid 'country' — a 2-letter ISO code, e.g. TR");
  const from = (params.from || "").trim() || new Date().toISOString().slice(0, 10);
  if (!ISO_DATE.test(from)) throw new Error("'from' must be YYYY-MM-DD");
  const to = (params.to || "").trim();
  const addRaw = (params.add || "").trim();
  if (!to && !addRaw) throw new Error("Pass 'add' (number of business days to add) or 'to' (count business days until this date)");
  if (to && !ISO_DATE.test(to)) throw new Error("'to' must be YYYY-MM-DD");
  const add = addRaw ? Number(addRaw) : 0;
  if (addRaw && (!Number.isInteger(add) || Math.abs(add) > 3650)) throw new Error("'add' must be a whole number of days, at most 3650");

  const endGuess = to || addDays(from, Math.sign(add || 1) * (Math.abs(add) * 2 + 30));
  const years = Array.from(
    new Set([Number(from.slice(0, 4)), Number(endGuess.slice(0, 4))].flatMap((y) => [y - 1, y, y + 1])),
  ).filter((y) => y >= 1975 && y <= 2100);

  let holidays: Holiday[];
  try {
    holidays = await holidaysFor(country, years);
  } catch (e) {
    const err = new Error(`Holiday calendar unavailable for ${country}: ${(e as Error).message}`);
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  if (!holidays.length) {
    throw new Error(`No holiday calendar published for '${country}' — the source covers ~110 countries by ISO code`);
  }

  // A holiday observed in one province is not a national closure. Counting it
  // would move a national due date for the whole country, so regional entries
  // are excluded and listed separately instead of silently applied.
  const national = new Map(holidays.filter((h) => h.global).map((h) => [h.date, h]));
  const regional = holidays.filter((h) => !h.global).map((h) => ({ date: h.date, name: h.name, counties: h.counties }));

  const isBusiness = (iso: string) => !isWeekend(iso, country) && !national.has(iso);
  const skipped: Array<{ date: string; reason: string; name?: string }> = [];

  let result: string = from;
  let count = 0;
  if (addRaw) {
    const step = add >= 0 ? 1 : -1;
    let remaining = Math.abs(add);
    let cur = from;
    while (remaining > 0) {
      cur = addDays(cur, step);
      if (isBusiness(cur)) remaining--;
      else if (skipped.length < 60) {
        skipped.push({ date: cur, reason: national.has(cur) ? "public_holiday" : "weekend", name: national.get(cur)?.name });
      }
    }
    result = cur;
  } else {
    // Count business days in (from, to] — the same convention as "net 30".
    const forward = to >= from;
    let cur = from;
    while (cur !== to) {
      cur = addDays(cur, forward ? 1 : -1);
      if (isBusiness(cur)) count++;
      else if (skipped.length < 60) {
        skipped.push({ date: cur, reason: national.has(cur) ? "public_holiday" : "weekend", name: national.get(cur)?.name });
      }
    }
    if (!forward) count = -count;
  }

  return {
    country,
    from,
    ...(addRaw ? { add, resultDate: result, resultIsBusinessDay: isBusiness(result) } : { to, businessDays: count }),
    skipped,
    weekend: (WEEKENDS[country] ?? [6, 0]).map((d) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d]),
    nationalHolidaysConsidered: national.size,
    regionalHolidaysIgnored: regional,
    checkedAt: new Date().toISOString(),
    method:
      "National public holidays from the Nager.Date open calendar, plus the country's weekend. Holidays observed only in some provinces are NOT counted as closures — they are listed under regionalHolidaysIgnored so you can apply them if your case is regional.",
    disclaimer:
      "Public holidays only. Bank-specific closures, half-days, company holidays and religious observances that vary by employer are not included, and holiday calendars for future years can still change.",
  };
}

// ---------------------------------------------------------------------------
// Inflation
// ---------------------------------------------------------------------------

interface WbPoint {
  date: string;
  value: number | null;
}

export async function inflationAdjust(params: Record<string, string>) {
  const country = (params.country || "US").trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(country)) throw new Error("'country' must be a 2- or 3-letter ISO code, e.g. US or TUR");
  const amount = params.amount === undefined || params.amount === "" ? 1 : Number(params.amount);
  if (!Number.isFinite(amount)) throw new Error("'amount' must be a number");
  const fromYear = Number((params.from || "").trim());
  if (!Number.isInteger(fromYear) || fromYear < 1960 || fromYear > 2100) {
    throw new Error("Missing or invalid 'from' — a year, e.g. 2015 (the series starts in 1960)");
  }
  const toYear = params.to ? Number(String(params.to).trim()) : null;
  if (toYear !== null && (!Number.isInteger(toYear) || toYear < 1960 || toYear > 2100)) {
    throw new Error("'to' must be a year, e.g. 2025");
  }

  const url = `https://api.worldbank.org/v2/country/${encodeURIComponent(country)}/indicator/FP.CPI.TOTL?format=json&per_page=200`;
  let payload: [unknown, WbPoint[] | null];
  try {
    payload = (await getJson(url)) as [unknown, WbPoint[] | null];
  } catch (e) {
    const err = new Error(`Inflation source unavailable: ${(e as Error).message}`);
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  const series = (payload?.[1] ?? []).filter((p) => p && p.value !== null) as Array<{ date: string; value: number }>;
  if (!series.length) throw new Error(`No consumer-price series published for '${country}'`);

  const byYear = new Map(series.map((p) => [Number(p.date), p.value]));
  const availableYears = [...byYear.keys()].sort((a, b) => a - b);
  const latest = availableYears[availableYears.length - 1];

  const base = byYear.get(fromYear);
  if (base === undefined) {
    throw new Error(`No index value for ${fromYear} — available years for ${country}: ${availableYears[0]}-${latest}`);
  }
  // The series is annual and lags: asking for this year returns the newest year
  // that exists, and the answer says which one it used.
  const targetYear = toYear ?? latest;
  const target = byYear.get(targetYear) ?? byYear.get(latest)!;
  const usedYear = byYear.get(targetYear) !== undefined ? targetYear : latest;

  const factor = target / base;
  return {
    country,
    amount,
    fromYear,
    toYear: usedYear,
    requestedToYear: toYear,
    usedLatestAvailable: usedYear !== (toYear ?? usedYear),
    adjusted: Number((amount * factor).toFixed(4)),
    factor: Number(factor.toFixed(6)),
    cumulativeInflationPct: Number(((factor - 1) * 100).toFixed(2)),
    indexFrom: base,
    indexTo: target,
    availableYears: { first: availableYears[0], last: latest },
    checkedAt: new Date().toISOString(),
    guidance:
      usedYear !== (toYear ?? usedYear)
        ? `The series has no value for ${toYear}; ${usedYear} is the most recent published year and was used instead.`
        : `${amount} in ${fromYear} has the purchasing power of about ${Number((amount * factor).toFixed(2))} in ${usedYear}.`,
    method:
      "World Bank consumer price index (FP.CPI.TOTL, 2010 = 100), annual averages. The adjustment is the ratio of the two years' index values.",
    disclaimer:
      "Annual averages for a whole national basket — not a month, not a city, not your basket. National statistics offices revise these figures, and the most recent year is usually published with a lag.",
  };
}
