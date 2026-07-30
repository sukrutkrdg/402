/**
 * Horizontal web services — the first endpoints here that have nothing to do
 * with a blockchain.
 *
 * The market analysis was blunt: crypto/onchain is 31% of the x402 index and the
 * most crowded category on it, while the widest-selling endpoints on the network
 * are plain capabilities every agent needs — read this page, turn it into JSON.
 * These two sell the fetch layer we already had to build safely, and they carry
 * no per-call upstream cost beyond bandwidth (url-to-json adds one LLM call).
 */

import "server-only";
import { fetchPage } from "./web-fetch";
import { aiExtract } from "./ai";

/**
 * Refuse pages we couldn't actually read, so the buyer isn't charged for
 * furniture.
 *
 * A big HTML payload that yields almost no prose is a client-rendered app: the
 * markup is a shell and the content arrives later via JavaScript, which we don't
 * execute. Returning the nav links from such a page would be technically a
 * response and practically worthless. Small pages are exempt — a genuinely short
 * page is short, not broken. Throwing here means x402 never settles.
 */
function assertReadable(page: { text: string; words: number; htmlBytes: number }): void {
  const clientRendered = page.words < 30 && page.htmlBytes > 50_000;
  if (!page.text || clientRendered) {
    throw new Error(
      "No readable text found — this page renders its content in the browser (JavaScript), so there is nothing to extract server-side. You were not charged.",
    );
  }
}

/** Read any web page and return clean, agent-ready text plus its metadata. */
export async function urlExtract(params: Record<string, string>) {
  const url = (params.url || "").trim();
  if (!url) throw new Error("Missing 'url'");
  const maxChars = Math.min(Math.max(Number(params.maxChars) || 40_000, 500), 100_000);

  const page = await fetchPage(url, maxChars);
  assertReadable(page);
  return {
    url: page.finalUrl,
    requestedUrl: url,
    title: page.title,
    description: page.description,
    siteName: page.siteName,
    text: page.text,
    chars: page.chars,
    words: page.words,
    truncated: page.truncated,
    redirects: page.redirects,
    contentType: page.contentType,
    fetchedAt: page.fetchedAt,
  };
}

/**
 * Read a page and return exactly the fields the caller asked for, as JSON.
 *
 * This is the pairing agents actually want: today they must fetch the page
 * themselves (usually from an environment with no browser and no HTML parser),
 * then call an extraction API with the text. One call instead of two.
 */
export async function urlToJson(params: Record<string, string>) {
  const url = (params.url || "").trim();
  if (!url) throw new Error("Missing 'url'");
  if (!(params.fields || "").trim()) throw new Error("Missing 'fields' — pass a comma-separated list");

  // 16K is the cap aiExtract already clamps to; fetching more would only be
  // thrown away by the extractor.
  const page = await fetchPage(url, 16_000);
  assertReadable(page);

  const extracted = (await aiExtract({
    text: page.text,
    fields: params.fields,
    list: params.list,
  })) as Record<string, unknown>;

  return {
    url: page.finalUrl,
    requestedUrl: url,
    title: page.title,
    ...extracted,
    source: {
      chars: page.chars,
      words: page.words,
      truncated: page.truncated,
      fetchedAt: page.fetchedAt,
    },
  };
}
