/**
 * Address structure + geocoding via OpenStreetMap Nominatim.
 */

import "server-only";
import { assertSafeUrl } from "./ssrf";

const UA = "x402-bazaar/1.0 (+https://402.com.tr; paid API on behalf of a caller)";
const TIMEOUT_MS = 10_000;

const at = () => new Date().toISOString();

/** Cheap structural checks per country — not postal delivery proof. */
export function addressCheck(params: Record<string, string>) {
  const country = (params.country || "").trim().toUpperCase();
  const line1 = (params.line1 || params.street || "").trim();
  const city = (params.city || "").trim();
  const postal = (params.postal || params.zip || "").trim();
  const line2 = (params.line2 || "").trim();
  if (!country || !/^[A-Z]{2}$/.test(country)) throw new Error("Provide country= as ISO-2, e.g. TR");
  if (!line1) throw new Error("Provide line1= (street address)");
  if (!city) throw new Error("Provide city=");

  const issues: string[] = [];
  const POSTAL: Record<string, RegExp> = {
    US: /^\d{5}(-\d{4})?$/,
    TR: /^\d{5}$/,
    GB: /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i,
    DE: /^\d{5}$/,
    FR: /^\d{5}$/,
    NL: /^\d{4}\s*[A-Z]{2}$/i,
    BE: /^\d{4}$/,
    ES: /^\d{5}$/,
    IT: /^\d{5}$/,
    PL: /^\d{2}-?\d{3}$/,
    CA: /^[A-Z]\d[A-Z]\s*\d[A-Z]\d$/i,
    AU: /^\d{4}$/,
  };

  if (postal) {
    const re = POSTAL[country];
    if (re && !re.test(postal)) issues.push(`postal '${postal}' does not match ${country} pattern`);
  } else {
    issues.push("postal code missing");
  }
  if (line1.length < 3) issues.push("line1 looks too short");
  if (/\b(P\.?\s*O\.?\s*Box|Postfach)\b/i.test(line1) && country === "TR") {
    issues.push("PO Box style line — confirm delivery rules for this country");
  }

  const normalised = {
    country,
    line1,
    line2: line2 || null,
    city,
    postal: postal || null,
    singleLine: [line1, line2, postal, city, country].filter(Boolean).join(", "),
  };

  return {
    valid: issues.length === 0,
    issues,
    address: normalised,
    note:
      "Offline structure only. Does not prove the address exists, is deliverable, or matches a resident.",
    checkedAt: at(),
  };
}

export async function geocode(params: Record<string, string>) {
  const q = (params.q || params.address || "").trim();
  const lat = (params.lat || "").trim();
  const lon = (params.lon || params.lng || "").trim();
  const mode = lat && lon ? "reverse" : "forward";

  if (mode === "forward" && !q) throw new Error("Provide q= (address text) or lat=+lon= for reverse");
  if (mode === "reverse") {
    if (!/^-?\d+(\.\d+)?$/.test(lat) || !/^-?\d+(\.\d+)?$/.test(lon)) {
      throw new Error("lat= and lon= must be decimal degrees");
    }
  }

  const url =
    mode === "reverse"
      ? `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&addressdetails=1`
      : `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=5&addressdetails=1`;

  await assertSafeUrl(url, "geocode");
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error(`Geocoder unavailable: ${(e as Error).message}`);
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Geocoder responded ${res.status}`);
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  const data = (await res.json()) as unknown;

  const mapHit = (h: Record<string, unknown>) => ({
    displayName: String(h.display_name ?? ""),
    lat: Number(h.lat),
    lon: Number(h.lon),
    type: h.type ?? null,
    importance: h.importance ?? null,
    address: h.address ?? null,
  });

  if (mode === "reverse") {
    const h = data as Record<string, unknown>;
    if (!h || !h.lat) {
      return { mode, found: false, result: null, note: "No reverse result", checkedAt: at(), source: "OpenStreetMap Nominatim" };
    }
    return { mode, found: true, result: mapHit(h), note: "OSM Nominatim reverse geocode", checkedAt: at(), source: "OpenStreetMap Nominatim" };
  }

  const list = Array.isArray(data) ? data : [];
  return {
    mode,
    found: list.length > 0,
    count: list.length,
    results: list.slice(0, 5).map((h) => mapHit(h as Record<string, unknown>)),
    note: "OSM Nominatim forward geocode — community data, not a postal authority",
    checkedAt: at(),
    source: "OpenStreetMap Nominatim",
  };
}
