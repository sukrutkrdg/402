/**
 * Business verification, compliance, FX, shipping, and enterprise office services
 */

import type { ServiceDef } from "./types";
import { emailVerify } from "../email-verify";
import { domainCheck } from "../domain-check";
import { companyLei, counterpartyCheck } from "../counterparty";
import { onrampCoverage, onrampQuote } from "../onramp";
import { businessDays, fxConvert, inflationAdjust } from "../reference";
import { ibanCheck } from "../iban";
import { phoneCheck } from "../phone";
import { vatCheck } from "../vat";
import { bicCheck, binCheck, sepaCreditorCheck, taxIdCheck } from "../business-bank";
import { addressCheck, geocode } from "../business-geo";
import { hsCodeSuggest, trackingDetect } from "../business-ship";
import { breachCheck, companySearch, sslCheck, urlRisk } from "../business-trust";
import { bankCsvNormalize, holidayCalendar, meetingSlots, qrEncode, receiptParse, settlementLine, upcLookup } from "../business-office";
import { dnsLookup } from "../commodity-data";

export const BUSINESS_SERVICES: ServiceDef[] = [
  {
      id: "email-verify",
      name: "Email Verify",
      tagline: "Is this address worth sending to?",
      description:
        "Syntax + live DNS (MX/A) + disposable, role and consumer-mailbox detection, as one GO / HOLD / STOP verdict with the reasons listed. Catches throwaway inboxes, support@-style shared mailboxes and one-character domain typos (gmial.com). No SMTP probe, so mailbox existence is not claimed.",
      price: "$0.02",
      icon: "✉️",
      category: "Business",
      params: [{ name: "email", label: "Email address", placeholder: "someone@example.com", required: true }],
      handler: emailVerify,
    },
  {
      id: "domain-check",
      name: "Domain Check",
      tagline: "How old is this domain, and is it still live?",
      description:
        "Registration age, expiry and registry status for any domain, from RDAP — the registries' own protocol. Returns days since registration, days to expiry, registrar, EPP status codes, nameservers and DNSSEC as one GO / HOLD / STOP verdict. Domain age is the strongest cheap signal in invoice and vendor-impersonation fraud: the payment details that change always arrive from a domain registered weeks ago. Refuses rather than guessing when a registry publishes no RDAP.",
      price: "$0.02",
      icon: "🌍",
      category: "Business",
      params: [{ name: "domain", label: "Domain name", placeholder: "example.com", required: true }],
      handler: domainCheck,
    },
  {
      id: "counterparty-check",
      name: "Counterparty Check",
      tagline: "Should you pay this supplier?",
      description:
        "One call, four public sources: how old the domain is (RDAP), whether mail to the contact will land (DNS), whether the name is on the OFAC list, and whether the company exists in the global LEI register. Returns a single GO / HOLD / STOP with every signal that produced it. Built for the moment an agent has to trust an invoice, a new vendor or a payment-detail change — the classic fraud pattern is a real-looking name on a domain registered weeks ago.",
      price: "$0.12",
      icon: "🤝",
      category: "Business",
      params: [
        { name: "domain", label: "Company domain", placeholder: "acme-supplies.com", required: false },
        { name: "email", label: "Contact email (its domain is used if 'domain' is omitted)", placeholder: "billing@acme-supplies.com" },
        { name: "name", label: "Legal company name (enables OFAC + LEI)", placeholder: "Acme Supplies Ltd" },
      ],
      handler: counterpartyCheck,
    },
  {
      id: "onramp-quote",
      name: "Fiat Onramp Quote",
      tagline: "What every payment rail really costs, side by side",
      description:
        "🆕 Prices the same fiat purchase across EVERY payment method a country allows, and ranks them by what the buyer actually receives. On $100 in the US the spread is real: card takes 2.44, bank transfer 0.50, a funded fiat wallet nothing. Returns each rail's fee, net amount, min/max limits, and the cheapest one. Live Coinbase pricing, not a rate card. Pass address= for a payable checkout link. Not financial advice.",
      price: "$0.03",
      icon: "🏦",
      category: "Business",
      params: [
        { name: "country", label: "ISO country code", placeholder: "US", required: true },
        { name: "amount", label: "Fiat amount", placeholder: "100", required: true },
        { name: "asset", label: "Asset to buy (optional, default USDC)", placeholder: "USDC" },
        { name: "network", label: "Network (optional, default base)", placeholder: "base" },
        { name: "currency", label: "Fiat currency (optional, default USD)", placeholder: "EUR" },
        { name: "address", label: "Destination wallet (optional — needed for a checkout link)", placeholder: "0x… wallet" },
      ],
      handler: onrampQuote,
      noFreeTier: true,
    },
  {
      id: "onramp-coverage",
      name: "Fiat Rails by Country",
      tagline: "Can money get in and out of crypto here, and how?",
      description:
        "🆕 The feasibility check before you ask a user for money: which fiat-in and cash-out rails Coinbase actually runs in a country, the currencies and min/max limits for each, and how many assets across which networks. Distinguishes a country with card rails from one where crypto can only be transferred in — a difference most integrations discover only after a user fails. 122 countries covered.",
      price: "$0.02",
      icon: "🌍",
      category: "Business",
      params: [{ name: "country", label: "ISO country code", placeholder: "DE", required: true }],
      handler: onrampCoverage,
      noFreeTier: true,
    },
  {
      id: "fx-convert",
      name: "FX Convert",
      tagline: "Convert an amount at the ECB's published rate",
      description:
        "Convert between 30+ currencies at the European Central Bank's daily reference rate, for today or any past date. Returns the converted amount, the per-unit rate and the date the rate is actually from — the ECB publishes on business days only, so a weekend date answers with the previous business day and says so instead of pretending. Reference rates for accounting and reporting, not tradable quotes.",
      price: "$0.002",
      icon: "💱",
      category: "Business",
      params: [
        { name: "from", label: "Source currency", placeholder: "USD", required: true },
        { name: "to", label: "Target currency (or several, comma-separated)", placeholder: "EUR,TRY", required: true },
        { name: "amount", label: "Amount (optional, default 1)", placeholder: "100" },
        { name: "date", label: "Date (optional, YYYY-MM-DD)", placeholder: "2026-07-24" },
      ],
      handler: fxConvert,
    },
  {
      id: "iban-check",
      name: "IBAN Check",
      tagline: "Is this bank account number even structurally possible?",
      description:
        "Validate an IBAN offline: country registry length, structure, and the ISO 7064 mod-97 checksum that catches what humans and spreadsheets actually get wrong — a transposed pair, a dropped character, an O typed for a zero. Returns the normalised and print-formatted forms, country, SEPA membership, and the bank identifier where the layout is known. Every rejection names WHICH check failed, so you know whether to fix the row or drop it. Structure only: a valid IBAN is not proof the account exists.",
      price: "$0.002",
      icon: "🏦",
      category: "Business",
      params: [
        { name: "iban", label: "IBAN", placeholder: "GB82 WEST 1234 5698 7654 32", required: true },
      ],
      handler: async (p: Record<string, string>) => ibanCheck(p),
    },
  {
      id: "phone-check",
      name: "Phone Check",
      tagline: "Normalise any phone number to E.164, and say what is knowable",
      description:
        "Turn the many ways a phone number gets typed into one E.164 string: strips spacing, brackets, the 00 international prefix and the national trunk zero people include out of habit. Returns country, calling code, national number, and whether the length matches that country's numbering plan. Line type (mobile / fixed) is reported ONLY for countries whose ranges are unambiguous and is null elsewhere with a reason — never guessed. Offline: it does not check that the number is assigned or reachable.",
      price: "$0.002",
      icon: "📞",
      category: "Business",
      params: [
        { name: "phone", label: "Phone number", placeholder: "+90 532 123 45 67", required: true },
        { name: "country", label: "Calling code, if the number has no +", placeholder: "44" },
      ],
      handler: async (p: Record<string, string>) => phoneCheck(p),
    },
  {
      id: "vat-check",
      name: "EU VAT Check",
      tagline: "Is this VAT number well-formed — and was the checksum actually run?",
      description:
        "Validate an EU VAT number offline: country prefix, national format, and the published check-digit algorithm for the 8 countries that have one (BE, DE, FR, IT, LU, NL, PL, PT). The response says which of the two you got — checksumChecked distinguishes a verified number from a format-only pass, because they are not the same strength of answer. Registration is deliberately NOT claimed: only VIES can say whether a number is registered, and this endpoint does not call it.",
      price: "$0.002",
      icon: "🧾",
      category: "Business",
      params: [
        { name: "vat", label: "VAT number", placeholder: "BE0417497106", required: true },
      ],
      handler: async (p: Record<string, string>) => vatCheck(p),
    },
  {
      id: "business-days",
      name: "Business Days",
      tagline: "Net 30 — but which 30, in which country?",
      description:
        "Add business days to a date, or count them between two dates, for ~110 countries. Knows each country's weekend (Friday-Saturday where that applies, not just Sat-Sun) and its national public holidays, and names every day it skipped. Holidays observed only in some provinces are deliberately NOT treated as national closures — they are listed separately so you can apply them when your case is regional. Built for payment terms, SLAs and delivery dates.",
      price: "$0.002",
      icon: "📅",
      category: "Business",
      params: [
        { name: "country", label: "Country (2-letter ISO)", placeholder: "TR", required: true },
        { name: "from", label: "Start date (optional, defaults to today)", placeholder: "2026-08-03" },
        { name: "add", label: "Business days to add", placeholder: "30" },
        { name: "to", label: "…or an end date, to count business days instead", placeholder: "2026-09-15" },
      ],
      handler: businessDays,
    },
  {
      id: "inflation-adjust",
      name: "Inflation Adjust",
      tagline: "What is 2015 money worth today?",
      description:
        "Restate an amount from one year in another year's money, for any country in the World Bank consumer-price series (1960 onwards). Returns the adjusted amount, the cumulative inflation and both index values so the arithmetic is checkable. The series is annual and published with a lag, so a request for a year that does not exist yet answers with the newest one available and says which. For contract comparisons, historical pricing and long-running budgets.",
      price: "$0.002",
      icon: "📉",
      category: "Business",
      params: [
        { name: "from", label: "Year the amount is in", placeholder: "2015", required: true },
        { name: "amount", label: "Amount (optional, default 1)", placeholder: "1000" },
        { name: "to", label: "Year to restate it in (optional, defaults to latest)", placeholder: "2025" },
        { name: "country", label: "Country ISO code (optional, default US)", placeholder: "TR" },
      ],
      handler: inflationAdjust,
    },
  {
      id: "company-lei",
      name: "Company LEI",
      tagline: "Does this company legally exist, and where?",
      description:
        "Look a company up in GLEIF, the global Legal Entity Identifier register: LEI code, registered legal name, entity status, registration status, jurisdiction and address. The register's own name filter is a token search that returns thousands of unrelated rows, so matches are re-checked here and only an exact one — or one differing solely in legal form (Inc/Ltd/GmbH) — is reported as found; the rest come back as candidates.",
      price: "$0.005",
      icon: "🏛️",
      category: "Business",
      params: [{ name: "name", label: "Company legal name", placeholder: "Coinbase Global, Inc.", required: true }],
      handler: companyLei,
    },
  {
      id: "bic-check",
      name: "BIC / SWIFT Check",
      tagline: "Is this bank code even well-formed?",
      description:
        "Validate a BIC/SWIFT code offline (ISO 9362): 8 or 11 characters, bank/country/location[/branch] layout, head-office vs branch, and the test-BIC flag. Every rejection names which check failed. Structure only — does not prove the bank is live.",
      price: "$0.002",
      icon: "🏦",
      category: "Business",
      params: [{ name: "bic", label: "BIC / SWIFT", placeholder: "DEUTDEFFXXX", required: true }],
      handler: async (p) => bicCheck(p),
    },
  {
      id: "bin-check",
      name: "Card BIN Check",
      tagline: "Scheme from the first 6–8 digits — never a full PAN",
      description:
        "Offline Issuer Identification Number check: accepts 6–8 digits only (refuses anything that looks like a full PAN), returns Visa/Mastercard/Amex/Discover/JCB/UnionPay/Maestro when the prefix is known. Not a live BIN registry lookup.",
      price: "$0.002",
      icon: "💳",
      category: "Business",
      params: [{ name: "bin", label: "BIN (6–8 digits)", placeholder: "424242", required: true }],
      handler: async (p) => binCheck(p),
    },
  {
      id: "sepa-creditor",
      name: "SEPA Creditor ID",
      tagline: "Is this Creditor Identifier self-consistent?",
      description:
        "Validate a SEPA Creditor Identifier offline: country, check digits (mod-97), business code and national id. Catches mistyped creditor ids before a mandate setup. Structure only — not a scheme-manager registration proof.",
      price: "$0.002",
      icon: "🇪🇺",
      category: "Business",
      params: [{ name: "creditorId", label: "Creditor Identifier", placeholder: "DE98ZZZ09999999999", required: true }],
      handler: async (p) => sepaCreditorCheck(p),
    },
  {
      id: "tax-id-check",
      name: "Tax ID Check",
      tagline: "EORI, EIN, TCKN and friends — format first",
      description:
        "Offline tax/customs id formats: EORI, US EIN/SSN, UK NINO, AU ABN (checksum), TR VKN/TCKN (checksum), CA BN. kind= selects the scheme. A well-formed id is not proof of registration.",
      price: "$0.002",
      icon: "🧾",
      category: "Business",
      params: [
        { name: "kind", label: "Kind", placeholder: "EORI", required: true },
        { name: "value", label: "Identifier", placeholder: "DE123456789012345", required: true },
      ],
      handler: async (p) => taxIdCheck(p),
    },
  {
      id: "address-check",
      name: "Address Check",
      tagline: "Postal shape for TR/US/EU — before you ship",
      description:
        "Structural address check: country, street, city, and postal pattern for common countries (TR, US, GB, DE, FR, NL, …). Returns a normalised single-line form and named issues. Not proof of deliverability.",
      price: "$0.002",
      icon: "📫",
      category: "Business",
      params: [
        { name: "country", label: "Country (ISO-2)", placeholder: "TR", required: true },
        { name: "line1", label: "Street line", placeholder: "Atatürk Cad. No:1", required: true },
        { name: "city", label: "City", placeholder: "Istanbul", required: true },
        { name: "postal", label: "Postal code", placeholder: "34000" },
        { name: "line2", label: "Line 2 (optional)", placeholder: "Daire 4" },
      ],
      handler: async (p) => addressCheck(p),
    },
  {
      id: "geocode",
      name: "Geocode",
      tagline: "Address ↔ coordinates via OpenStreetMap",
      description:
        "Forward geocode an address (q=) or reverse geocode lat=+lon= using OpenStreetMap Nominatim. Returns up to 5 hits with display name and address parts. Community map data — not a postal authority.",
      price: "$0.01",
      icon: "📍",
      category: "Business",
      params: [
        { name: "q", label: "Address text (forward)", placeholder: "Brandenburg Gate, Berlin" },
        { name: "lat", label: "Latitude (reverse)", placeholder: "52.5163" },
        { name: "lon", label: "Longitude (reverse)", placeholder: "13.3777" },
      ],
      handler: geocode,
    },
  {
      id: "tracking-detect",
      name: "Tracking Detect",
      tagline: "Which carrier is this tracking number?",
      description:
        "Guess UPS / FedEx / USPS / DHL / DPD / TNT / TR carriers from tracking-number shape and return a carrier tracking URL. Live parcel status is NOT fetched — pattern detection only.",
      price: "$0.002",
      icon: "📦",
      category: "Business",
      params: [{ name: "tracking", label: "Tracking number", placeholder: "1Z999AA10123456784", required: true }],
      handler: async (p) => trackingDetect(p),
    },
  {
      id: "hs-code",
      name: "HS Code Suggest",
      tagline: "Product text → Harmonized System chapter hint",
      description:
        "Map a short product description to likely HS chapter/heading hints (electronics, apparel, coffee, pharma, …). Keyword table only — not a binding customs classification; confirm before filing.",
      price: "$0.005",
      icon: "🛃",
      category: "Business",
      params: [{ name: "q", label: "Product description", placeholder: "wireless bluetooth headphones", required: true }],
      handler: async (p) => hsCodeSuggest(p),
    },
  {
      id: "company-search",
      name: "Company Search",
      tagline: "Find a company in OpenCorporates",
      description:
        "Search company registers via OpenCorporates: name, number, jurisdiction, incorporation date, status, and a source URL. Optional jurisdiction= filter. Attribution included. Not a credit score.",
      price: "$0.02",
      icon: "🏢",
      category: "Business",
      params: [
        { name: "q", label: "Company name", placeholder: "Coinbase", required: true },
        { name: "jurisdiction", label: "Jurisdiction code (optional)", placeholder: "us_de" },
      ],
      handler: companySearch,
      /**
       * Hidden 2026-09-10: the upstream now requires a key we do not hold.
       *
       * `api.opencorporates.com/v0.4/companies/search` answers 401 `Invalid Api
       * Token` to an unauthenticated request — the open tier this was written
       * against is gone. Every call fails, so the endpoint could never earn:
       * withX402 settles only after a handler returns under 400, which is why
       * nobody was charged for the failures and why it never entered the
       * discovery index. It was the one service out of nineteen that would not
       * settle when they were seeded.
       *
       * Hidden rather than deleted. The handler is correct and the only missing
       * piece is a credential, so this comes back by setting a key and removing
       * this flag. Leaving it listed would put a guaranteed error in front of the
       * agents now finding us, which costs more than the service is worth.
       */
      hidden: true,
    },
  {
      id: "ssl-check",
      name: "SSL Cert Check",
      tagline: "When does this host's certificate expire?",
      description:
        "TLS probe for host=: subject, issuer, validFrom/validTo, daysRemaining, expired/expiringSoon, fingerprint. GO/HOLD/STOP from dates. Chain trust is not asserted — dates and identity fields are.",
      price: "$0.01",
      icon: "🔒",
      category: "Business",
      params: [
        { name: "host", label: "Hostname", placeholder: "402.com.tr", required: true },
        { name: "port", label: "Port (optional)", placeholder: "443" },
      ],
      handler: sslCheck,
    },
  {
      id: "breach-check",
      name: "Password Breach Check",
      tagline: "Has this password appeared in a dump?",
      description:
        "Have I Been Pwned Pwned Passwords via k-anonymity: only a 5-char SHA-1 prefix leaves the server. Returns pwned + occurrence count and a GO/HOLD/STOP. Password is not stored. Email breach lookup not offered.",
      price: "$0.005",
      icon: "⚠️",
      category: "Business",
      params: [{ name: "password", label: "Password to check", placeholder: "(never logged)", required: true }],
      handler: breachCheck,
      noFreeTier: true,
    },
  {
      id: "url-risk",
      name: "URL Risk",
      tagline: "Cheap phishing heuristics before you click",
      description:
        "Heuristic URL risk: scheme, IP hosts, deep subdomains, credential-themed labels, sensitive paths/params, optional brand= lookalike. Returns reasons + GO/HOLD/STOP. Not a malware or Safe Browsing scan.",
      price: "$0.002",
      icon: "🔗",
      category: "Business",
      params: [
        { name: "url", label: "URL", placeholder: "https://example.com/", required: true },
        { name: "brand", label: "Expected brand host (optional)", placeholder: "coinbase.com" },
      ],
      handler: async (p) => urlRisk(p),
    },
  {
      id: "receipt-parse",
      name: "Receipt Parse",
      tagline: "Pull totals, IBAN, dates out of receipt text",
      description:
        "Heuristic extraction from invoice/receipt text: totals, amounts, VAT hints, IBANs, dates, emails, invoice numbers. Not OCR — convert a scan to text first, then send it here.",
      price: "$0.01",
      icon: "🧾",
      category: "Business",
      params: [
        {
          name: "text",
          label: "Receipt / invoice text",
          placeholder: "Invoice #A-100\nTOTAL: 120.50 USD\nIBAN GB82WEST12345698765432\nDate 2026-09-01",
          required: true,
          multiline: true,
        },
      ],
      handler: async (p) => receiptParse(p),
    },
  {
      id: "meeting-slots",
      name: "Meeting Slots",
      tagline: "Overlap office hours across timezones",
      description:
        "Find 30-minute UTC slots where every zone is inside a local window (default 09–17) on a given date. Pass zones= IANA list. Does not know holidays or personal calendars.",
      price: "$0.002",
      icon: "🗓️",
      category: "Business",
      params: [
        { name: "zones", label: "Timezones (comma-separated)", placeholder: "Europe/Istanbul,America/New_York", required: true },
        { name: "date", label: "Date YYYY-MM-DD", placeholder: "2026-09-15" },
        { name: "startHour", label: "Local start hour", placeholder: "9" },
        { name: "endHour", label: "Local end hour", placeholder: "17" },
      ],
      handler: async (p) => meetingSlots(p),
    },
  {
      id: "holiday-calendar",
      name: "Holiday Calendar",
      tagline: "Public holidays for a country and year",
      description:
        "List public holidays for country= + year= from Nager.Date (~110 countries). Marks national vs regional entries. Same source business-days uses — for agents that need the raw calendar.",
      price: "$0.002",
      icon: "🎌",
      category: "Business",
      params: [
        { name: "country", label: "Country (ISO-2)", placeholder: "TR", required: true },
        { name: "year", label: "Year", placeholder: "2026" },
      ],
      handler: holidayCalendar,
    },
  {
      id: "qr-encode",
      name: "QR Encode",
      tagline: "Text in, SVG (or data-URL) QR out",
      description:
        "Encode text= into a QR code as SVG (default) or format=dataurl PNG. Offline, no upstream. Built for agents putting payment links, IBANs or URLs onto a page.",
      price: "$0.002",
      icon: "▣",
      category: "Business",
      params: [
        { name: "text", label: "Payload", placeholder: "https://402.com.tr", required: true },
        { name: "format", label: "svg (default) or dataurl", placeholder: "svg" },
      ],
      handler: qrEncode,
    },
  {
      id: "upc-lookup",
      name: "UPC / EAN Lookup",
      tagline: "Checksum + Open Food Facts product hit",
      description:
        "Validate UPC/EAN/GTIN checksum offline, then look up the barcode on Open Food Facts when it is a food/consumer item. Non-food codes often checksum-ok with no product match.",
      price: "$0.01",
      icon: "🏷️",
      category: "Business",
      params: [{ name: "code", label: "Barcode digits", placeholder: "3017620422003", required: true }],
      handler: upcLookup,
    },
  {
      id: "settlement-line",
      name: "Settlement Ledger Line",
      tagline: "USDC payment → double-entry journal stub",
      description:
        "Turn a USDC settlement into bookkeeping lines: amount, accounts, memo, optional Base tx= enrichment (status, timestamp, to). Returns journal JSON plus a two-line CSV. Not tax advice.",
      price: "$0.005",
      icon: "📘",
      category: "Business",
      params: [
        { name: "amount", label: "Amount", placeholder: "12.50" },
        { name: "asset", label: "Asset", placeholder: "USDC" },
        { name: "counterparty", label: "Counterparty", placeholder: "0x…" },
        { name: "memo", label: "Memo", placeholder: "Invoice 1042" },
        { name: "tx", label: "Base tx hash (optional)", placeholder: "0x…" },
        { name: "debitAccount", label: "Debit account", placeholder: "Crypto Clearing" },
        { name: "creditAccount", label: "Credit account", placeholder: "Accounts Receivable" },
      ],
      handler: settlementLine,
    },
  {
      id: "bank-csv",
      name: "Bank CSV Normalize",
      tagline: "Messy bank export → one row shape",
      description:
        "Parse a bank CSV (comma/semicolon/tab, quoted fields) and map common headers (date/amount/debit/credit/balance/description, TR aliases) into one schema. Up to 500 rows. Best-effort.",
      price: "$0.01",
      icon: "📊",
      category: "Business",
      params: [
        {
          name: "text",
          label: "CSV text",
          placeholder: "Date,Description,Amount\n2026-01-02,Coffee,-4.50\n2026-01-03,Payroll,1000.00",
          required: true,
          multiline: true,
        },
      ],
      handler: async (p) => bankCsvNormalize(p),
    },
  {
      id: "dns-lookup",
      name: "DNS Lookup",
      tagline: "A / AAAA / MX / TXT / NS / CNAME records for any domain",
      description:
        "Resolve DNS records for a domain via Cloudflare DNS-over-HTTPS — A, AAAA, MX, TXT, NS, CNAME, SOA. Pass name= and type= (default A). Returns each record with its TTL, plus NXDOMAIN when the name does not exist. The DNS commodity agents call constantly for infra, email and domain checks, served at the sub-cent floor. Not financial advice.",
      price: "$0.002",
      icon: "🌐",
      category: "Business",
      params: [
        { name: "name", label: "Domain", placeholder: "coinbase.com", required: true },
        { name: "type", label: "Record type (default A)", placeholder: "A" },
      ],
      handler: dnsLookup,
    },
];
