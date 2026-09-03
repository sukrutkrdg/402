/**
 * Exa search, resold over x402 — under Exa's name, on purpose.
 *
 * WHY THIS EXISTS WHEN `web-search` ALREADY SELLS SEARCH
 * -----------------------------------------------------
 * `web-search` was built in August 2026 on exactly the right reasoning: search
 * is the one category in the discovery index with proven, broad, repeat demand,
 * and the winners are the operators reselling an engine rather than the engines
 * themselves. It then wrapped Tavily and was called `web-search`, and it has one
 * payer in thirty days — us. The reasoning was right and the naming threw the
 * result away.
 *
 * The 2026-09-03 index read says what the difference is, and it is not price,
 * depth or metadata:
 *
 *   stableenrich.dev/api/exa/search    $0.0100   38,885 calls   232 payers
 *   api.exa.ai/search                  $0.0070    3,466 calls    88 payers
 *   blockrun.ai/api/v1/exa/search      $0.0110    2,246 calls    30 payers
 *   vaaya.ai/api/run/exa/search        $0.0100      348 calls    28 payers
 *   402.com.tr/api/x402/web-search     $0.0100        2 calls     1 payer
 *
 * Every row above ours carries `exa` in its PATH. The best-performing reseller
 * charges more than Exa does and draws ten times Exa's own traffic. Agents do
 * not browse for a capability, they search for a name they already trust, and
 * the resource URL is what the index matches on. So this endpoint is deliberately
 * `/api/x402/exa-search`.
 *
 * The same read says not to do this with Tavily: `x402.tavily.com/search` takes
 * 1,997 calls across 101 payers, and every Tavily reseller in the index is in
 * single digits (`vaaya.ai/api/run/tavily/search`: 5 calls, 2 payers). Tavily
 * runs its own x402 endpoint and keeps its own demand. Exa does not.
 *
 * MARGIN — why there is no page text at the entry price
 * ----------------------------------------------------
 * Exa bills $7/1k for a search of up to 10 results, then $1/1k per result beyond
 * ten, and $1/1k per page PER CONTENT TYPE for anything under `contents`. At the
 * market's $0.01:
 *
 *   10 results, no contents          $0.007   → sells at $0.01, 30% margin
 *   10 results + highlights          $0.017   → sells at $0.01, a loss
 *   25 results, no contents          $0.022   → sells at $0.01, a loss
 *
 * So the entry price sells ranked results and nothing else, results are capped
 * at ten, and the deep search types ($12–$15/1k) are not offered at all — the
 * same discipline that keeps `web-search` on Tavily's basic depth. Highlights are
 * real value, so they are a priced mode rather than a missing feature: `text=1`
 * caps results at five and costs us $0.012 against a $0.03 sale. Both tiers are
 * quoted by `effectivePriceFor`, so the 402 challenge and the credit debit agree.
 *
 * New Exa accounts get $20 of credit and the free tier adds $10 a month, so the
 * first few thousand searches cost nothing at all.
 */

import "server-only";
import { finish } from "./envelope";

const ENDPOINT = "https://api.exa.ai/search";
const TIMEOUT_MS = 20_000;

/**
 * Exa's price step. The first ten results are inside the flat $7/1k; the
 * eleventh starts billing $1/1k each, which a flat sale price cannot absorb.
 */
const MAX_RESULTS = 10;
/**
 * With highlights every returned result also bills $1/1k as a content page, so
 * the batch has to be smaller for the higher tier to keep its margin.
 */
const MAX_RESULTS_WITH_TEXT = 5;

/**
 * Search types we will sell. `deep-lite`, `deep` and `deep-reasoning` bill
 * $12–$15/1k — above our sale price at every tier — so they are not reachable
 * from the parameter, and an unknown value falls back to `auto` rather than
 * erroring: a caller who guesses a type name should still get a search.
 */
const SELLABLE_TYPES = new Set(["auto", "fast", "instant"]);

interface ExaResult {
  id?: string;
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string | null;
  score?: number;
  highlights?: string[];
}

interface ExaResponse {
  requestId?: string;
  results?: ExaResult[];
  searchTime?: number;
  costDollars?: { total?: number };
}

export function exaConfigured(): boolean {
  return Boolean(process.env.EXA_API_KEY?.trim());
}

/**
 * True when this call is in the higher (`text=1`) price tier.
 *
 * Exported because the price has to be decided in `effectivePriceFor`, before
 * the handler runs, and the two must not each carry their own copy of the test —
 * that is precisely how `url-to-json` came to charge the x402 rail one price and
 * the credit rail another.
 */
export function exaWantsText(raw: string): boolean {
  return /^(true|1|yes)$/i.test((raw || "").trim());
}

/**
 * Search the live web through Exa and return ranked results.
 *
 * Throws before calling Exa when the key is missing or the query is empty:
 * `withX402` only settles on a handler that returns, so a request we cannot
 * serve is never billed.
 */
export async function exaSearch(params: Record<string, string>) {
  const key = process.env.EXA_API_KEY?.trim();
  if (!key) throw new Error("Exa search not configured: set EXA_API_KEY");

  const query = (params.query || "").trim();
  if (!query) throw new Error("Missing 'query'");

  const withText = exaWantsText(params.text || "");
  const cap = withText ? MAX_RESULTS_WITH_TEXT : MAX_RESULTS;
  const numResults = Math.min(Math.max(Number(params.numResults) || 5, 1), cap);

  const requested = (params.type || "").trim().toLowerCase();
  const type = SELLABLE_TYPES.has(requested) ? requested : "auto";

  // Exa takes up to 1200 domains; we take a short list because the price is flat
  // and a 1200-entry body is not what a $0.01 call is buying.
  const domains = (params.includeDomains || "")
    .split(",")
    .map((d) => d.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean)
    .slice(0, 20);

  const body: Record<string, unknown> = { query, numResults, type };
  if (domains.length) body.includeDomains = domains;
  // Highlights are the only content type we buy, and only in the paid-up tier —
  // `text` would bill the same again per page for far more bytes than a $0.03
  // call should carry.
  if (withText) body.contents = { highlights: true };

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("Exa upstream unreachable — you were not charged.");
  }

  if (!res.ok) {
    // Pass the upstream's own reason through: a 401 is our key to fix, a 400 is
    // the caller's query, and a blanket failure hides which.
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Exa upstream failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }

  const data = (await res.json()) as ExaResponse;
  const results = (data.results ?? []).map((r) => ({
    title: r.title ?? null,
    url: r.url ?? null,
    publishedDate: r.publishedDate ?? null,
    author: r.author ?? null,
    score: typeof r.score === "number" ? Number(r.score.toFixed(4)) : null,
    // Present and null in the entry tier rather than absent, so one response
    // shape covers both tiers and a caller can test the field either way.
    highlights: withText ? (r.highlights ?? []) : null,
  }));

  // An empty result set is a real answer to a real search — Exa was paid, we
  // were served, and "nothing matched" is what the caller needed to know. It is
  // not a refusal, so it settles.
  return finish({
    query,
    type,
    results,
    resultCount: results.length,
    highlightsIncluded: withText,
    ...(domains.length ? { includeDomains: domains } : {}),
    upstream: "exa",
    upstreamMs: typeof data.searchTime === "number" ? Math.round(data.searchTime) : null,
  });
}
