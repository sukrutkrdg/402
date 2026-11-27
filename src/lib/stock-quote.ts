/**
 * Real-equity spot price by ticker — Yahoo Finance chart API, keyless.
 * Used to measure how far a tokenized stock's on-chain price has drifted from the
 * real stock it tracks (a de-peg). Reusable by any stock service. Not advice.
 */
import "server-only";

/** Last regular-market price for a ticker (e.g. "AAPL", "SPY"), or null. */
export async function realStockPrice(ticker: string): Promise<number | null> {
  try {
    const t = ticker.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
    if (!t) return null;
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=1d`,
      { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { chart?: { result?: { meta?: { regularMarketPrice?: number } }[] } };
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}
