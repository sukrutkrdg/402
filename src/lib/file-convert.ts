/**
 * Format conversion — CSV/TSV ↔ JSON, Markdown → HTML.
 *
 * WHY: the highest-volume agent we have seen on this network (25 sellers, 1727
 * payments in 30 days) pays a third party for exactly this, alongside search and
 * summarisation. It is the least glamorous thing an agent needs and one of the
 * most constant: data arrives in one shape and the next step wants another. No
 * upstream, no model call — pure CPU, so the margin is entirely ours.
 *
 * The parsing is the product. A CSV splitter written with `split(",")` breaks on
 * the first quoted field containing a comma, and returns something that looks
 * like data — which is worse than failing, because the caller ships it.
 */

import "server-only";

const MAX_INPUT = 200_000; // characters — a large spreadsheet, not a database
const MAX_ROWS = 20_000;

/**
 * RFC 4180 CSV, with the parts real files actually use: quoted fields, embedded
 * separators and newlines, doubled quotes as an escape, and CRLF endings.
 */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false; // distinguishes a trailing newline from an empty last row

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      started = true;
      continue;
    }
    if (c === sep) {
      row.push(field);
      field = "";
      started = true;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (started || field !== "" || row.length) {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        started = false;
      }
      continue;
    }
    field += c;
    started = true;
  }
  if (started || field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Numbers and booleans become themselves; everything else stays a string. */
function coerce(v: string): string | number | boolean | null {
  const t = v.trim();
  if (t === "") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  // Only plain numbers — not "0123" (an identifier) and not "1,234" (formatted).
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

export function delimitedToJson(text: string, sep: string, typed: boolean): Record<string, unknown>[] {
  const rows = parseDelimited(text, sep);
  if (!rows.length) return [];
  const header = rows[0].map((h, i) => h.trim() || `column_${i + 1}`);
  const out: Record<string, unknown>[] = [];
  for (const r of rows.slice(0, MAX_ROWS + 1).slice(1)) {
    const obj: Record<string, unknown> = {};
    header.forEach((h, i) => {
      const raw = r[i] ?? "";
      obj[h] = typed ? coerce(raw) : raw;
    });
    out.push(obj);
  }
  return out;
}

/** One CSV cell, quoted only when it has to be. */
function csvCell(v: unknown, sep: string): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return new RegExp(`["\\n\\r${sep === "\t" ? "\\t" : sep}]`).test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function jsonToDelimited(data: unknown, sep: string): string {
  const rows = Array.isArray(data) ? data : [data];
  if (!rows.length) return "";
  // The union of every row's keys, in first-seen order: a row missing a field
  // must still line up with the header rather than shifting the columns.
  const header: string[] = [];
  for (const r of rows) {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      for (const k of Object.keys(r)) if (!header.includes(k)) header.push(k);
    }
  }
  if (!header.length) return rows.map((r) => csvCell(r, sep)).join("\n");
  const lines = [header.map((h) => csvCell(h, sep)).join(sep)];
  for (const r of rows.slice(0, MAX_ROWS)) {
    const o = (r ?? {}) as Record<string, unknown>;
    lines.push(header.map((h) => csvCell(o[h], sep)).join(sep));
  }
  return lines.join("\n");
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Markdown → HTML, deliberately small.
 *
 * Everything is HTML-escaped FIRST, so markdown input can never inject a script:
 * this output is handed to a browser, and a converter that passes raw HTML
 * through is a stored-XSS generator with a price tag on it.
 */
export function markdownToHtml(md: string): string {
  const blocks: string[] = [];
  const lines = escapeHtml(md.replace(/\r\n?/g, "\n")).split("\n");
  let i = 0;

  const inline = (s: string) =>
    s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      // Every link is matched, then filtered: an unsafe scheme becomes plain
      // text rather than being left as literal `[x](javascript:…)` markup.
      // javascript: and data: URLs in a published page are the same XSS hole by
      // another route, and a link the reader can still copy out is not "dropped".
      .replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (_m, t, href) => {
        const safe = String(href).trim();
        return /^https?:\/\//i.test(safe) ? `<a href="${safe}" rel="noopener nofollow">${t}</a>` : String(t);
      });

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(`<pre><code>${body.join("\n")}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      blocks.push("<hr>");
      i++;
      continue;
    }
    // Table: a header row followed by a |---|---| separator.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (r: string) =>
        r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]));
      blocks.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }
    const listMatch = line.match(/^\s*([-*+]|\d+\.)\s+/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1]);
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*([-*+]|\d+\.)\s+/)) {
        items.push(inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "")));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      blocks.push(`<${tag}>${items.map((t) => `<li>${t}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) body.push(lines[i++].replace(/^&gt;\s?/, ""));
      blocks.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|\s*[-*+]\s|\d+\.\s|&gt;)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return blocks.join("\n");
}

const FORMATS = ["csv", "tsv", "json", "md", "html"] as const;
type Format = (typeof FORMATS)[number];

export async function fileConvert(params: Record<string, string>) {
  const text = params.text ?? "";
  if (!text.trim()) throw new Error("Missing 'text' — pass the content to convert");
  if (text.length > MAX_INPUT) throw new Error(`Input too large: ${text.length} characters, limit is ${MAX_INPUT}`);

  const from = String(params.from || "").toLowerCase() as Format;
  const to = String(params.to || "").toLowerCase() as Format;
  if (!FORMATS.includes(from) || !FORMATS.includes(to)) {
    throw new Error(`'from' and 'to' must each be one of: ${FORMATS.join(", ")}`);
  }
  if (from === to) throw new Error("'from' and 'to' are the same — nothing to convert");

  const typed = params.typed !== "false"; // numbers/booleans become real types by default
  let output: string;
  let rows: number | null = null;

  if ((from === "csv" || from === "tsv") && to === "json") {
    const data = delimitedToJson(text, from === "tsv" ? "\t" : ",", typed);
    rows = data.length;
    output = JSON.stringify(data, null, 2);
  } else if (from === "json" && (to === "csv" || to === "tsv")) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Input is not valid JSON: ${(e as Error).message}`);
    }
    rows = Array.isArray(data) ? data.length : 1;
    output = jsonToDelimited(data, to === "tsv" ? "\t" : ",");
  } else if (from === "md" && to === "html") {
    output = markdownToHtml(text);
  } else if ((from === "csv" || from === "tsv") && to === "md") {
    const data = delimitedToJson(text, from === "tsv" ? "\t" : ",", false);
    rows = data.length;
    const header = Object.keys(data[0] ?? {});
    output = header.length
      ? [
          `| ${header.join(" | ")} |`,
          `| ${header.map(() => "---").join(" | ")} |`,
          ...data.map((r) => `| ${header.map((h) => String(r[h] ?? "")).join(" | ")} |`),
        ].join("\n")
      : "";
  } else {
    throw new Error(
      `Unsupported conversion ${from} → ${to}. Supported: csv/tsv → json, csv/tsv → md, json → csv/tsv, md → html`,
    );
  }

  return {
    from,
    to,
    rows,
    inputChars: text.length,
    outputChars: output.length,
    output,
    truncated: rows !== null && rows >= MAX_ROWS,
    checkedAt: new Date().toISOString(),
    method:
      "Local parsing only — no model call, no upstream. CSV follows RFC 4180 (quoted fields, embedded separators and newlines, doubled quotes). Markdown output is HTML-escaped before rendering, and only http(s) links survive.",
    limits: { maxInputChars: MAX_INPUT, maxRows: MAX_ROWS },
  };
}
