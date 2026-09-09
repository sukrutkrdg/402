/**
 * Shipping carrier detection + HS code suggestion — offline pattern tables.
 */

import "server-only";

const at = () => new Date().toISOString();

interface CarrierRule {
  carrier: string;
  test: RegExp;
  trackUrl: (n: string) => string;
}

const CARRIERS: CarrierRule[] = [
  { carrier: "UPS", test: /\b1Z[A-Z0-9]{16}\b/i, trackUrl: (n) => `https://www.ups.com/track?tracknum=${n}` },
  { carrier: "FedEx", test: /\b(\d{12}|\d{15}|\d{20}|\d{22})\b/, trackUrl: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  { carrier: "USPS", test: /\b(94\d{20}|93\d{20}|92\d{20}|EA\d{9}US|EC\d{9}US|CP\d{9}US)\b/i, trackUrl: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}` },
  { carrier: "DHL", test: /\b(\d{10,11}|\d{18,22})\b/, trackUrl: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${n}` },
  { carrier: "DPD", test: /\b%?\d{10,14}\b/, trackUrl: (n) => `https://tracking.dpd.de/status/en_US/parcel/${n}` },
  { carrier: "TNT", test: /\b\d{9}\b/, trackUrl: (n) => `https://www.tnt.com/express/en_us/site/tracking.html?searchType=con&cons=${n}` },
  { carrier: "Yurtiçi Kargo", test: /\b\d{10,12}\b/, trackUrl: (n) => `https://www.yurticikargo.com/tr/online-servisler/gonderi-sorgula?code=${n}` },
  { carrier: "Aras Kargo", test: /\b\d{10,12}\b/, trackUrl: (n) => `https://www.araskargo.com.tr/trtrack/?code=${n}` },
];

export function trackingDetect(params: Record<string, string>) {
  const raw = (params.tracking || params.number || params.value || "").trim();
  if (!raw) throw new Error("Provide tracking= number");
  const compact = raw.replace(/\s/g, "").toUpperCase();
  const matches: Array<{ carrier: string; trackingUrl: string; confidence: string }> = [];

  for (const c of CARRIERS) {
    if (c.test.test(compact) || c.test.test(raw)) {
      matches.push({ carrier: c.carrier, trackingUrl: c.trackUrl(compact), confidence: "pattern" });
    }
  }

  // Prefer the most specific: UPS 1Z wins over generic digit lengths.
  const preferred =
    matches.find((m) => m.carrier === "UPS") ||
    matches.find((m) => m.carrier === "USPS") ||
    matches[0] ||
    null;

  return {
    tracking: compact,
    found: Boolean(preferred),
    carrier: preferred?.carrier ?? null,
    trackingUrl: preferred?.trackingUrl ?? null,
    candidates: matches.slice(0, 5),
    liveStatus: null,
    note:
      "Carrier guessed from tracking-number shape only. Live parcel status is NOT fetched — open trackingUrl at the carrier, or wire a carrier API.",
    checkedAt: at(),
  };
}

/** Keyword → HS chapter suggestions (Harmonized System, 2–4 digit). */
const HS_RULES: Array<{ chapter: string; heading?: string; label: string; keys: string[] }> = [
  { chapter: "09", heading: "0901", label: "Coffee", keys: ["coffee", "kahve", "espresso"] },
  { chapter: "10", heading: "1001", label: "Wheat / cereals", keys: ["wheat", "buğday", "flour", "un"] },
  { chapter: "22", heading: "2204", label: "Wine", keys: ["wine", "şarap", "champagne"] },
  { chapter: "27", heading: "2710", label: "Petroleum oils", keys: ["oil", "diesel", "petrol", "gasoline"] },
  { chapter: "30", heading: "3004", label: "Medicaments", keys: ["medicine", "drug", "pharma", "ilaç", "tablet"] },
  { chapter: "39", heading: "3923", label: "Plastic packaging", keys: ["plastic", "polymer", "plastik", "packaging"] },
  { chapter: "48", heading: "4802", label: "Paper", keys: ["paper", "kağıt", "cardboard", "karton"] },
  { chapter: "61", heading: "6109", label: "T-shirts / knit apparel", keys: ["tshirt", "t-shirt", "apparel", "clothing", "giyim", "shirt"] },
  { chapter: "64", heading: "6403", label: "Footwear", keys: ["shoe", "sneaker", "boot", "ayakkabı"] },
  { chapter: "72", heading: "7208", label: "Iron / steel flat", keys: ["steel", "iron", "çelik", "metal sheet"] },
  { chapter: "84", heading: "8471", label: "Computers / ADP machines", keys: ["laptop", "computer", "server", "pc", "bilgisayar"] },
  { chapter: "85", heading: "8517", label: "Phones / telecom", keys: ["phone", "smartphone", "router", "modem", "telefon"] },
  { chapter: "85", heading: "8541", label: "Semiconductors", keys: ["chip", "semiconductor", "ic", "transistor"] },
  { chapter: "87", heading: "8703", label: "Motor cars", keys: ["car", "vehicle", "auto", "otomobil", "ev"] },
  { chapter: "90", heading: "9018", label: "Medical instruments", keys: ["syringe", "medical device", "diagnostic"] },
  { chapter: "94", heading: "9403", label: "Furniture", keys: ["furniture", "chair", "desk", "mobilya"] },
  { chapter: "95", heading: "9503", label: "Toys", keys: ["toy", "oyun", "lego"] },
];

export function hsCodeSuggest(params: Record<string, string>) {
  const text = (params.q || params.description || params.product || "").trim().toLowerCase();
  if (!text) throw new Error("Provide q= product description");
  if (text.length > 500) throw new Error("q= too long (max 500 chars)");

  const hits = HS_RULES.filter((r) => r.keys.some((k) => text.includes(k))).map((r) => ({
    chapter: r.chapter,
    heading: r.heading ?? null,
    label: r.label,
    hs6Hint: r.heading ? `${r.heading}00` : `${r.chapter}0000`,
  }));

  return {
    query: text,
    matches: hits.slice(0, 8),
    found: hits.length > 0,
    note:
      "Keyword → HS chapter/heading hints only. Not a binding customs classification — a licensed broker or your national tariff tool must confirm before filing.",
    checkedAt: at(),
  };
}
