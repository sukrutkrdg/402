/**
 * market-pulse — one trading-grade read of the market's state, where the single
 * fear-greed number isn't enough. Combines three independent angles an agent
 * would otherwise make three calls for:
 *
 *   mood      — crypto Fear & Greed (alternative.me): risk-on vs risk-off.
 *   attention — what retail is chasing right now (CoinGecko trending).
 *   leverage  — where perp funding is crowded market-wide (CoinGecko derivatives),
 *               OI-weighted — the positioning the F&G number can't see.
 *
 * The edge is the COMBINATION: greed + crowded longs = froth/long-squeeze risk;
 * fear + crowded shorts = capitulation/short-squeeze setup. One call, no key. A
 * sentiment/positioning gauge, not a signal. Not financial advice.
 */

import "server-only";

const CG = "https://api.coingecko.com/api/v3";

async function fearGreed(): Promise<{ value: number; label: string | null; prev: number | null } | null> {
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=2", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: Array<{ value?: string; value_classification?: string }> };
    const d = j.data ?? [];
    if (!d.length) return null;
    return { value: Number(d[0].value), label: d[0].value_classification ?? null, prev: d[1] ? Number(d[1].value) : null };
  } catch { return null; }
}

async function trending(): Promise<Array<{ symbol: string; change24hPct: number | null }> | null> {
  try {
    const r = await fetch(`${CG}/search/trending`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { coins?: Array<{ item?: { symbol?: string; data?: { price_change_percentage_24h?: { usd?: number } } } }> };
    return (j.coins ?? []).slice(0, 7).map((c) => ({ symbol: (c.item?.symbol ?? "").toUpperCase(), change24hPct: c.item?.data?.price_change_percentage_24h?.usd != null ? +c.item.data.price_change_percentage_24h.usd.toFixed(1) : null }));
  } catch { return null; }
}

async function fundingTilt(): Promise<{ annualizedPct: number; tilt: string } | null> {
  try {
    const r = await fetch(`${CG}/derivatives?include_tickers=unexpired`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!r.ok) return null;
    const all = (await r.json()) as Array<{ contract_type?: string; funding_rate?: number; open_interest?: number }>;
    if (!Array.isArray(all)) return null;
    let w = 0, oi = 0;
    for (const d of all) {
      if ((d.contract_type ?? "").toLowerCase() !== "perpetual") continue;
      const o = typeof d.open_interest === "number" ? d.open_interest : 0;
      const f = typeof d.funding_rate === "number" ? d.funding_rate : null;
      if (f !== null && o > 0) { w += f * o; oi += o; }
    }
    if (oi === 0) return null;
    const ann = +((w / oi) * 3 * 365).toFixed(1);
    return { annualizedPct: ann, tilt: ann > 5 ? "long_crowded" : ann < -5 ? "short_crowded" : "balanced" };
  } catch { return null; }
}

export async function marketPulse(_params: Record<string, string>) {
  const [fg, trend, fund] = await Promise.all([fearGreed(), trending(), fundingTilt()]);
  if (!fg && !trend && !fund) throw new Error("All sentiment sources unavailable — not charged, retry shortly");

  // Composite stance from mood × leverage.
  const greedy = fg ? fg.value >= 60 : null;
  const fearful = fg ? fg.value <= 40 : null;
  let stance: string;
  let read: string;
  if (greedy && fund?.tilt === "long_crowded") { stance = "frothy"; read = "Greed + crowded longs = froth. Local-top / long-squeeze risk on a dip; size down, tighten stops, don't chase."; }
  else if (fearful && fund?.tilt === "short_crowded") { stance = "capitulation_setup"; read = "Fear + crowded shorts = capitulation setup. Short-squeeze fuel on any bounce; contrarian longs watch, but it's fear for a reason."; }
  else if (greedy) { stance = "risk_on"; read = "Risk-on mood without extreme leverage crowding — trend-friendly, but greed can turn fast."; }
  else if (fearful) { stance = "risk_off"; read = "Risk-off / cautious mood. Defensive; wait for stabilisation or stronger confirmation."; }
  else { stance = "neutral"; read = "No strong mood or positioning edge — decide on the setup, not the tape."; }

  return {
    mood: fg ? { fearGreed: fg.value, label: fg.label, changeVsPrevDay: fg.prev != null ? fg.value - fg.prev : null } : null,
    leverage: fund ? { annualizedFundingPct: fund.annualizedPct, tilt: fund.tilt } : null,
    attention: trend ? { trending: trend } : null,
    sourcesUsed: [fg ? "fear-greed" : null, trend ? "trending" : null, fund ? "funding" : null].filter(Boolean),
    stance, // frothy | capitulation_setup | risk_on | risk_off | neutral
    recommendation: read + (trend && trend.length ? ` Attention is on ${trend.slice(0, 3).map((t) => t.symbol).join(", ")} — vet anything trending with token-risk before touching it.` : ""),
    note: "Trading-grade market pulse: Fear & Greed (mood) + CoinGecko trending (attention) + OI-weighted perp funding (leverage positioning), combined. The combination is the edge the single F&G number misses. A gauge, not a signal; partial if a source is down. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
