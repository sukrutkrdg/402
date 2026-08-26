/**
 * Live web search, resold over x402.
 *
 * WHY THIS ENDPOINT EXISTS: the 2026-08-26 sweep of the whole discovery index
 * (15,150 rows) found web search to be the one category with proven, repeat,
 * broad demand — and the winners are not the search engines themselves but the
 * operators reselling them per call. `stableenrich.dev/api/exa/search` ($0.01)
 * draws 243 unique payers at 69 calls each, more than `api.exa.ai` does
 * directly; `x402.tavily.com/search` ($0.01) draws 235. Nobody browses the
 * catalog looking for our hostname; they look for a capability they already
 * know they want. This is that capability.
 *
 * MARGIN: Tavily bills 1 credit per basic search, $0.008/credit pay-as-you-go,
 * with the first 1,000 credits each month free. We charge $0.01, so the endpoint
 * is pure margin under the monthly free allowance and ~20% over it. Advanced
 * depth costs 2 credits and would not clear the market's $0.01 median, so basic
 * is the only depth we sell.
 */

import "server-only";
import { finish } from "./envelope";

const ENDPOINT = "https://api.tavily.com/search";
const EXTRACT_ENDPOINT = "https://api.tavily.com/extract";
const TIMEOUT_MS = 15_000;
const EXTRACT_TIMEOUT_MS = 30_000;
/** Tavily's own cap; asking for more is a 400 rather than a clamp. */
const MAX_RESULTS_CAP = 20;
/**
 * Basic extract bills 1 credit per 5 successful URLs, so a batch of 5 is exactly
 * one credit ($0.008) and a batch of 6 is two. Capping at 5 keeps a single flat
 * price honest for every input — a per-call price with an uncapped batch loses
 * money on the first caller who passes six.
 */
const EXTRACT_URL_CAP = 5;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilyResponse {
  query?: string;
  answer?: string | null;
  results?: TavilyResult[];
  response_time?: number;
}

export function searchConfigured(): boolean {
  return Boolean(process.env.TAVILY_API_KEY?.trim());
}

/**
 * Search the live web and return ranked results plus a synthesized answer.
 *
 * Throws before spending anything when the key is missing or the query is
 * empty — withX402 only settles on a handler that returns, so a caller is never
 * charged for a request we could not serve.
 */
export async function webSearch(params: Record<string, string>) {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) throw new Error("Search not configured: set TAVILY_API_KEY");

  const query = (params.query || "").trim();
  if (!query) throw new Error("Missing 'query'");

  const maxResults = Math.min(Math.max(Number(params.maxResults) || 5, 1), MAX_RESULTS_CAP);
  // Default on: the one-paragraph answer is the half an agent usually wants,
  // and Tavily charges no extra credit for it.
  const includeAnswer = !/^(false|0|no)$/i.test((params.includeAnswer || "").trim());

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        include_answer: includeAnswer,
        search_depth: "basic",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("Search upstream unreachable — you were not charged.");
  }

  if (!res.ok) {
    // Surface the upstream's own reason rather than a generic failure: a 432
    // (credits exhausted) is ours to fix, a 400 is the caller's.
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Search upstream failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }

  const data = (await res.json()) as TavilyResponse;
  const results = (data.results ?? []).map((r) => ({
    title: r.title ?? null,
    url: r.url ?? null,
    snippet: r.content ?? null,
    score: typeof r.score === "number" ? Number(r.score.toFixed(4)) : null,
  }));

  return finish({
    query: data.query ?? query,
    answer: data.answer ?? null,
    results,
    resultCount: results.length,
    upstreamMs: typeof data.response_time === "number" ? Math.round(data.response_time * 1000) : null,
  });
}

interface TavilyExtractResult {
  url?: string;
  title?: string;
  raw_content?: string;
}

interface TavilyExtractResponse {
  results?: TavilyExtractResult[];
  failed_results?: Array<{ url?: string; error?: string }>;
  response_time?: number;
}

/**
 * Read up to five pages in one call, including the ones our own fetcher refuses.
 *
 * This does NOT replace url-extract. That endpoint costs us bandwidth and
 * nothing else, so it stays the cheap path for a single static page. What it
 * cannot do is a page that renders its content in the browser — `assertReadable`
 * deliberately refuses those rather than return nav furniture as if it were the
 * article. This one renders, and takes a batch. Those two differences are the
 * whole reason it exists; pick url-extract when neither applies.
 */
export async function webExtract(params: Record<string, string>) {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) throw new Error("Extract not configured: set TAVILY_API_KEY");

  const urls = (params.urls || params.url || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (!urls.length) throw new Error("Missing 'urls' — pass one URL or a comma-separated list");
  if (urls.length > EXTRACT_URL_CAP) {
    // Refuse rather than silently truncate: a caller who passed eight URLs and
    // got five back has no way to tell which three we dropped, and paid anyway.
    throw new Error(
      `Too many URLs: ${urls.length}. This endpoint reads up to ${EXTRACT_URL_CAP} per call — split the list and call again. You were not charged.`,
    );
  }

  let res: Response;
  try {
    res = await fetch(EXTRACT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      // Basic depth only — advanced doubles the credit cost and would not clear
      // the market's price band for this call.
      body: JSON.stringify({ urls, extract_depth: "basic" }),
      cache: "no-store",
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Extract upstream unreachable — you were not charged.");
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Extract upstream failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }

  const data = (await res.json()) as TavilyExtractResponse;
  const pages = (data.results ?? []).map((r) => ({
    url: r.url ?? null,
    title: r.title ?? null,
    text: r.raw_content ?? null,
    chars: (r.raw_content ?? "").length,
  }));
  const failed = (data.failed_results ?? []).map((f) => ({
    url: f.url ?? null,
    error: f.error ?? "unknown",
  }));

  // Every URL failing means the caller got nothing readable. Throwing here means
  // x402 never settles, so a batch of five dead links is free rather than billed.
  if (!pages.length) {
    throw new Error(
      `None of the ${urls.length} URL(s) could be read${failed[0]?.error ? `: ${failed[0].error}` : ""}. You were not charged.`,
    );
  }

  return finish({
    pages,
    pageCount: pages.length,
    failed,
    requested: urls.length,
    upstreamMs: typeof data.response_time === "number" ? Math.round(data.response_time * 1000) : null,
  });
}
