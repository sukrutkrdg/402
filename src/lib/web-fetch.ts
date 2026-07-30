/**
 * Fetch a caller-supplied web page and turn it into clean text.
 *
 * WHY THIS IS THE HORIZONTAL BET: the market data says the widest-selling x402
 * endpoints are not deep vertical expertise — they're capabilities every agent
 * needs regardless of domain. URL-to-text is the second-biggest earner on the
 * whole network, and unlike search or enrichment it needs no paid upstream: the
 * cost is our own bandwidth, so the margin is ours.
 *
 * SECURITY: this endpoint fetches whatever URL a stranger hands us, which is a
 * proxy into our network if done naively. Every hop goes through the SSRF gate —
 * not just the first, because a public host is free to redirect into the cloud
 * metadata service. Responses are capped by size and time, and non-text content
 * types are refused rather than streamed into memory.
 */

import "server-only";
import { assertSafeUrl } from "./ssrf";

const MAX_BYTES = 2_000_000; // 2 MB of HTML is a very large article
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 12_000;
const UA = "x402-bazaar/1.0 (+https://402.com.tr; paid API on behalf of a caller)";

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  text: string;
  chars: number;
  words: number;
  truncated: boolean;
  redirects: number;
  /** Size of the HTML we read, used to spot client-rendered pages. */
  htmlBytes: number;
  fetchedAt: string;
}

const TEXTUAL = /^(text\/|application\/(xhtml\+xml|xml|json|rss\+xml|atom\+xml))/i;

/** Minimal HTML entity decode — the handful that actually show up in prose. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)));
}

function metaContent(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      const v = decodeEntities(m[1]).trim();
      if (v) return v.slice(0, 400);
    }
  }
  return null;
}

/**
 * Strip a page down to its readable prose.
 *
 * Deliberately not a dependency: a readability port would pull a DOM into the
 * bundle for what amounts to "drop the furniture, keep the paragraphs". We
 * prefer <article>/<main> when the page marks it, which is what most publishers
 * do, and fall back to the whole body.
 */
export function htmlToText(html: string): string {
  let s = html;
  // Order matters: kill script/style content before any tag stripping, or their
  // bodies survive as text.
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<(script|style|noscript|svg)\b[^>]*\/>/gi, " ");

  // Prefer the main content region when the page declares one.
  const main = s.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ?? s.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main?.[1] && main[1].length > 400) s = main[1];
  else {
    s = s.replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  }

  // Keep block boundaries as newlines so paragraphs don't run together.
  s = s.replace(/<(\/?)(p|div|section|li|tr|h[1-6]|blockquote|pre|br)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** Read at most `MAX_BYTES` so a hostile server can't stream us out of memory. */
async function readCapped(res: Response): Promise<{ body: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { body: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      chunks.push(value.subarray(0, Math.max(0, value.byteLength - (size - MAX_BYTES))));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return { body: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)), truncated };
}

/**
 * Fetch `raw` and return its readable text. Throws with a caller-facing message
 * on anything we won't serve — a throw before the response means x402 never
 * settles, so the buyer isn't charged for a page we couldn't read.
 */
export async function fetchPage(raw: string, maxChars = 40_000): Promise<FetchedPage> {
  let current = (raw || "").trim();
  if (!current) throw new Error("Missing 'url'");
  // Accept a bare domain the way a person would type it.
  if (!/^https?:\/\//i.test(current)) current = `https://${current}`;

  let redirects = 0;
  let res: Response;
  for (;;) {
    // Re-validated on EVERY hop: the SSRF check is worthless if a redirect can
    // land us on 169.254.169.254 after the first host passed.
    const url = await assertSafeUrl(current, "url");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      res = await fetch(url.toString(), {
        redirect: "manual",
        signal: ctl.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
      });
    } catch (e) {
      throw new Error(
        (e as Error)?.name === "AbortError" ? "Page did not respond in time" : "Page could not be fetched",
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Page returned ${res.status} with no redirect target`);
      if (++redirects > MAX_REDIRECTS) throw new Error("Too many redirects");
      current = new URL(location, current).toString();
      continue;
    }
    break;
  }

  if (res.status >= 400) throw new Error(`Page returned HTTP ${res.status}`);

  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType && !TEXTUAL.test(contentType)) {
    throw new Error(`Unsupported content type '${contentType}' — this endpoint reads text and HTML pages`);
  }

  const { body, truncated: bytesTruncated } = await readCapped(res);
  const isHtml = !contentType || /html|xml/.test(contentType);
  const text = isHtml ? htmlToText(body) : body.trim();

  const title = isHtml
    ? metaContent(body, [
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
        /<title[^>]*>([\s\S]*?)<\/title>/i,
      ])
    : null;
  const description = isHtml
    ? metaContent(body, [
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      ])
    : null;
  const siteName = isHtml
    ? metaContent(body, [/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i])
    : null;

  const clipped = text.length > maxChars;
  const out = clipped ? text.slice(0, maxChars) : text;
  return {
    finalUrl: current,
    status: res.status,
    contentType: contentType || "unknown",
    title,
    description,
    siteName,
    text: out,
    chars: out.length,
    words: out ? out.split(/\s+/).filter(Boolean).length : 0,
    truncated: clipped || bytesTruncated,
    redirects,
    htmlBytes: body.length,
    fetchedAt: new Date().toISOString(),
  };
}
