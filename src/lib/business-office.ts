/**
 * Office-agent utilities: receipt text parse, meeting slots, holidays, QR, barcode/UPC,
 * USDC settlement → ledger line, bank CSV normalize.
 */

import "server-only";
import QRCode from "qrcode";
import { createPublicClient } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { assertSafeUrl } from "./ssrf";

const UA = "x402-bazaar/1.0 (+https://402.com.tr; paid API on behalf of a caller)";
const TIMEOUT_MS = 10_000;
const at = () => new Date().toISOString();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function receiptParse(params: Record<string, string>) {
  const text = (params.text || params.receipt || "").trim();
  if (!text) throw new Error("Provide text= receipt / invoice body");
  if (text.length > 20_000) throw new Error("text= too long (max 20k)");

  const money = [...text.matchAll(/(?:TRY|TL|USD|EUR|GBP|\$|€|£)\s*([0-9]+[.,][0-9]{2})|([0-9]+[.,][0-9]{2})\s*(?:TRY|TL|USD|EUR|GBP)/gi)].map(
    (m) => (m[1] || m[2] || "").replace(",", "."),
  );
  const totals = [...text.matchAll(/(?:total|toplam|amount due|grand total)\s*[:.]?\s*(?:TRY|TL|USD|EUR|\$|€)?\s*([0-9]+[.,][0-9]{2})/gi)].map(
    (m) => m[1].replace(",", "."),
  );
  const vat = [...text.matchAll(/(?:VAT|KDV|tax)\s*[:%.]?\s*([0-9]+[.,]?[0-9]*)/gi)].map((m) => m[1]);
  const ibans = [...text.matchAll(/\b([A-Z]{2}\d{2}[A-Z0-9]{10,30})\b/g)].map((m) => m[1]);
  const dates = [...text.matchAll(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})\b/g)].map((m) => m[1]);
  const emails = [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0]);
  const invoiceNos = [...text.matchAll(/(?:invoice|fatura|receipt)\s*[#:]?\s*([A-Z0-9-]{4,})/gi)].map((m) => m[1]);

  return {
    totalHint: totals[0] ?? money[money.length - 1] ?? null,
    amounts: [...new Set(money)].slice(0, 20),
    vatHints: [...new Set(vat)].slice(0, 10),
    ibans: [...new Set(ibans)].slice(0, 5),
    dates: [...new Set(dates)].slice(0, 10),
    emails: [...new Set(emails)].slice(0, 5),
    invoiceNumbers: [...new Set(invoiceNos)].slice(0, 5),
    note: "Heuristic text extraction — not OCR. For a scanned image, OCR first then send the text here.",
    checkedAt: at(),
  };
}

export function meetingSlots(params: Record<string, string>) {
  const zonesRaw = (params.zones || params.timezones || "").trim();
  if (!zonesRaw) throw new Error("Provide zones= comma-separated IANA timezones, e.g. Europe/Istanbul,America/New_York");
  const zones = zonesRaw.split(",").map((z) => z.trim()).filter(Boolean);
  if (zones.length < 2 || zones.length > 8) throw new Error("Pass 2–8 timezones");
  const date = (params.date || "").trim() || new Date().toISOString().slice(0, 10);
  if (!ISO_DATE.test(date)) throw new Error("date= must be YYYY-MM-DD");
  const startHour = Number(params.startHour ?? "9");
  const endHour = Number(params.endHour ?? "17");
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || endHour > 23 || startHour >= endHour) {
    throw new Error("startHour/endHour must be integers 0–23 with start < end (local window in EACH zone)");
  }

  // Validate zones early via Intl
  for (const z of zones) {
    try {
      Intl.DateTimeFormat("en-US", { timeZone: z }).format(new Date());
    } catch {
      throw new Error(`Unknown timezone '${z}' — use IANA names like Europe/Istanbul`);
    }
  }

  const slots: Array<{ utc: string; local: Record<string, string> }> = [];
  for (let hour = 0; hour < 24; hour++) {
    for (const minute of [0, 30]) {
      const utc = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
      const local: Record<string, string> = {};
      let ok = true;
      for (const z of zones) {
        const parts = new Intl.DateTimeFormat("en-GB", {
          timeZone: z,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(utc);
        const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
        const localDate = `${get("year")}-${get("month")}-${get("day")}`;
        const hh = Number(get("hour"));
        const mm = get("minute");
        if (localDate !== date || hh < startHour || hh >= endHour) {
          ok = false;
          break;
        }
        local[z] = `${String(hh).padStart(2, "0")}:${mm}`;
      }
      if (ok) slots.push({ utc: utc.toISOString(), local });
    }
  }

  return {
    date,
    zones,
    window: { startHour, endHour },
    slotCount: slots.length,
    slots: slots.slice(0, 48),
    note: "Overlap of local wall-clock windows on the given UTC calendar date. Does not know holidays or personal calendars.",
    checkedAt: at(),
  };
}

export async function holidayCalendar(params: Record<string, string>) {
  const country = (params.country || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("Provide country= ISO-2");
  const year = Number(params.year || new Date().getUTCFullYear());
  if (!Number.isInteger(year) || year < 1975 || year > 2100) throw new Error("year= out of range");

  const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error(`Holiday source unavailable: ${(e as Error).message}`);
    (err as Error & { status?: number }).status = 502;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Holiday source responded ${res.status} — country may be unsupported`);
    (err as Error & { status?: number }).status = res.status === 404 ? 400 : 502;
    throw err;
  }
  const list = (await res.json()) as Array<{
    date: string;
    localName: string;
    name: string;
    global: boolean;
    counties: string[] | null;
  }>;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`No holiday calendar published for '${country}'`);
  }

  return {
    country,
    year,
    count: list.length,
    holidays: list.map((h) => ({
      date: h.date,
      name: h.name,
      localName: h.localName,
      national: h.global,
      counties: h.counties,
    })),
    source: "Nager.Date",
    checkedAt: at(),
  };
}

export async function qrEncode(params: Record<string, string>) {
  const text = params.text ?? params.value ?? "";
  if (!text) throw new Error("Provide text= to encode");
  if (text.length > 1200) throw new Error("text= too long for a reliable QR (max 1200)");
  const format = ((params.format || "svg") as string).toLowerCase();
  if (format !== "svg" && format !== "dataurl") throw new Error("format= svg | dataurl");

  if (format === "dataurl") {
    const dataUrl = await QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 1, width: 256 });
    return { format, dataUrl, bytes: text.length, checkedAt: at() };
  }
  const svg = await QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  return { format: "svg", svg, bytes: text.length, checkedAt: at() };
}

function eanChecksum(digits: string): boolean {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  let sum = 0;
  const rev = body.split("").reverse();
  for (let i = 0; i < rev.length; i++) {
    const n = Number(rev[i]);
    sum += i % 2 === 0 ? n * 3 : n;
  }
  const expect = (10 - (sum % 10)) % 10;
  return expect === check;
}

export async function upcLookup(params: Record<string, string>) {
  const raw = (params.code || params.upc || params.ean || params.gtin || "").trim();
  if (!raw) throw new Error("Provide code= UPC/EAN/GTIN digits");
  const digits = raw.replace(/\D/g, "");
  const checksumOk = eanChecksum(digits);
  if (!checksumOk && !/^\d{8,14}$/.test(digits)) {
    return {
      code: digits,
      validChecksum: false,
      reason: "Not 8/12/13/14 digits or checksum failed",
      product: null,
      checkedAt: at(),
    };
  }

  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(digits)}.json`;
  await assertSafeUrl(url, "upc-lookup");
  let product: Record<string, unknown> | null = null;
  let source: string | null = null;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const json = (await res.json()) as { status?: number; product?: Record<string, unknown> };
      if (json.status === 1 && json.product) {
        const p = json.product;
        product = {
          name: p.product_name || p.generic_name || null,
          brands: p.brands || null,
          quantity: p.quantity || null,
          categories: p.categories || null,
          countries: p.countries || null,
          image: p.image_front_small_url || p.image_url || null,
        };
        source = "Open Food Facts";
      }
    }
  } catch {
    // checksum answer still useful if catalog is down
  }

  return {
    code: digits,
    validChecksum: checksumOk,
    found: Boolean(product),
    product,
    source,
    note: product
      ? "Product metadata from Open Food Facts when the barcode is a food/consumer item."
      : "Checksum evaluated offline; no Open Food Facts match (non-food barcodes often miss).",
    checkedAt: at(),
  };
}

export async function settlementLine(params: Record<string, string>) {
  const amount = (params.amount || "").trim();
  const asset = ((params.asset || "USDC").trim().toUpperCase());
  const counterparty = (params.counterparty || params.to || "").trim();
  const memo = (params.memo || params.description || "").trim();
  const txHash = (params.tx || params.txHash || "").trim();
  const debitAccount = (params.debitAccount || "Crypto Clearing").trim();
  const creditAccount = (params.creditAccount || "Accounts Receivable").trim();

  if (!amount && !txHash) throw new Error("Provide amount= (and optional tx=) or tx= alone to read onchain");

  let chainAmount = amount;
  let chainTo = counterparty;
  let chainAt: string | null = null;
  let chainStatus: string | null = null;

  if (txHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("tx= must be a 0x… 32-byte hash");
    const client = createPublicClient({ chain: base, transport: baseTransport() });
    const tx = await client.getTransaction({ hash: txHash as `0x${string}` }).catch(() => null);
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => null);
    if (!tx) {
      return {
        found: false,
        reason: "Transaction not found on Base",
        txHash,
        checkedAt: at(),
      };
    }
    chainTo = chainTo || tx.to || "";
    chainStatus = receipt ? (receipt.status === "success" ? "success" : "reverted") : "pending";
    if (receipt?.blockNumber) {
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      chainAt = new Date(Number(block.timestamp) * 1000).toISOString();
    }
    if (!chainAmount && tx.value > 0n) {
      chainAmount = (Number(tx.value) / 1e18).toFixed(6);
    }
  }

  if (!chainAmount) throw new Error("Could not determine amount — pass amount=");

  const entry = {
    date: (chainAt || at()).slice(0, 10),
    memo: memo || (txHash ? `Base settlement ${txHash.slice(0, 10)}…` : "USDC settlement"),
    lines: [
      { account: debitAccount, debit: chainAmount, credit: "0", asset },
      { account: creditAccount, debit: "0", credit: chainAmount, asset },
    ],
    counterparty: chainTo || null,
    txHash: txHash || null,
    chainStatus,
    settledAt: chainAt,
  };

  return {
    found: true,
    journal: entry,
    csv: `date,account,debit,credit,asset,memo,counterparty,tx\n${entry.date},${debitAccount},${chainAmount},0,${asset},"${entry.memo}",${chainTo},${txHash}\n${entry.date},${creditAccount},0,${chainAmount},${asset},"${entry.memo}",${chainTo},${txHash}`,
    note: "Accounting stub for bookkeeping agents. Not tax advice; confirm with your ledger chart of accounts.",
    checkedAt: at(),
  };
}

export function bankCsvNormalize(params: Record<string, string>) {
  const text = (params.text || params.csv || "").trim();
  if (!text) throw new Error("Provide text= bank CSV export");
  if (text.length > 200_000) throw new Error("text= too large (max 200k)");

  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("Need a header row and at least one data row");

  const parseRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === "," || ch === ";" || ch === "\t") {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };

  const header = parseRow(lines[0]).map((h) => h.toLowerCase());
  const find = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));

  const iDate = find("date", "tarih", "booking", "value date", "valuta");
  const iDesc = find("description", "memo", "narrative", "açıklama", "details", "payee");
  const iAmount = find("amount", "tutar", "sum");
  const iDebit = find("debit", "out", "withdrawal", "borç");
  const iCredit = find("credit", "in", "deposit", "alacak");
  const iBal = find("balance", "bakiye");

  if (iDate < 0 || (iAmount < 0 && iDebit < 0 && iCredit < 0)) {
    throw new Error("Could not detect date + amount columns — send a CSV with recognizable headers");
  }

  const rows: Array<{ date: string; description: string; amount: number; balance: number | null }> = [];
  for (const line of lines.slice(1, 501)) {
    const cols = parseRow(line);
    if (cols.every((c) => !c)) continue;
    const date = cols[iDate] || "";
    const description = iDesc >= 0 ? cols[iDesc] : "";
    let amount = 0;
    if (iAmount >= 0) {
      amount = Number(String(cols[iAmount]).replace(/[^0-9.,-]/g, "").replace(",", "."));
    } else {
      const d = iDebit >= 0 ? Number(String(cols[iDebit]).replace(/[^0-9.,-]/g, "").replace(",", ".")) || 0 : 0;
      const c = iCredit >= 0 ? Number(String(cols[iCredit]).replace(/[^0-9.,-]/g, "").replace(",", ".")) || 0 : 0;
      amount = c - d;
    }
    const balance =
      iBal >= 0 ? Number(String(cols[iBal]).replace(/[^0-9.,-]/g, "").replace(",", ".")) : null;
    if (!Number.isFinite(amount)) continue;
    rows.push({ date, description, amount, balance: Number.isFinite(balance as number) ? (balance as number) : null });
  }

  return {
    rowCount: rows.length,
    columnsDetected: { date: iDate, description: iDesc, amount: iAmount, debit: iDebit, credit: iCredit, balance: iBal },
    rows,
    note: "Best-effort normalization of common bank CSV headers. Capped at 500 data rows.",
    checkedAt: at(),
  };
}
