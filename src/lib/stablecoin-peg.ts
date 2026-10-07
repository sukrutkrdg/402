/**
 * Stablecoin peg monitor — are the dollars an agent is holding still worth a dollar?
 *
 * An agent parked in USDC/USDT/DAI treats them as $1.00 and prices everything off
 * that. A depeg breaks that silently: balanceOf does not change, the number in
 * the wallet does not change, only what it is worth does. This reads the live DEX
 * price of each major USD-pegged stablecoin on Base and reports the deviation
 * from $1.00, so an agent can notice before it settles a trade against a stale peg.
 *
 * USD-pegged only on purpose. EURC pegs to the euro, not the dollar, so scoring it
 * against $1.00 would be wrong by the EUR/USD rate — it is excluded rather than
 * mismeasured (an agent wanting EURC should use fx-convert + token-price).
 *
 * A price we could not read is "unknown", never 1.0 — a feed outage must not read
 * as a healthy peg, which is the one false-negative this exists to avoid.
 */

import "server-only";
import { tokenPrice } from "./onchain-extra";

/** Major USD-pegged stablecoins on Base, by DEX-priced contract. */
const USD_STABLES: Array<{ symbol: string; name: string; address: string }> = [
  { symbol: "USDC", name: "USD Coin", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { symbol: "USDT", name: "Tether USD", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" },
  { symbol: "DAI", name: "Dai", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" },
  { symbol: "USDbC", name: "USD Base Coin", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" },
];

/** Deviation thresholds in basis points from $1.00. */
const WATCH_BPS = 50; // 0.5%
const DEPEG_BPS = 200; // 2%

export interface PegRow {
  symbol: string;
  name: string;
  address: string;
  /** Live DEX price, or null when the feed could not be read. NEVER 1.0 as a stand-in. */
  priceUsd: number | null;
  /** Signed deviation from $1.00 in basis points (negative = under peg). null when unread. */
  deviationBps: number | null;
  liquidityUsd: number | null;
  status: "healthy" | "watch" | "depeg" | "unknown";
}

export function classify(priceUsd: number | null): { deviationBps: number | null; status: PegRow["status"] } {
  if (priceUsd === null || !Number.isFinite(priceUsd) || priceUsd <= 0) return { deviationBps: null, status: "unknown" };
  const deviationBps = Math.round((priceUsd - 1) * 10_000);
  const abs = Math.abs(deviationBps);
  const status = abs >= DEPEG_BPS ? "depeg" : abs >= WATCH_BPS ? "watch" : "healthy";
  return { deviationBps, status };
}

export async function stablecoinPeg(params: Record<string, string>) {
  // Optional single-symbol filter; default is the whole set.
  const only = (params.symbol || params.token || "").trim().toUpperCase();
  const set = only ? USD_STABLES.filter((s) => s.symbol.toUpperCase() === only) : USD_STABLES;
  if (only && set.length === 0) throw new Error(`Unknown or non-USD stablecoin: ${only}. Covered: ${USD_STABLES.map((s) => s.symbol).join(", ")} (USD-pegged only).`);

  const rows: PegRow[] = [];
  for (const s of set) {
    let priceUsd: number | null = null;
    let liquidityUsd: number | null = null;
    try {
      const p = (await tokenPrice({ address: s.address })) as { priceUsd?: string | null; liquidityUsd?: number | null };
      const n = p.priceUsd != null ? Number(p.priceUsd) : NaN;
      priceUsd = Number.isFinite(n) ? n : null;
      liquidityUsd = p.liquidityUsd ?? null;
    } catch {
      priceUsd = null; // feed outage → unknown, never 1.0
    }
    const { deviationBps, status } = classify(priceUsd);
    rows.push({ symbol: s.symbol, name: s.name, address: s.address, priceUsd, deviationBps, liquidityUsd, status });
  }

  const worst = rows.reduce<PegRow["status"]>((w, r) => {
    const rank = { healthy: 0, watch: 1, unknown: 2, depeg: 3 } as const;
    return rank[r.status] > rank[w] ? r.status : w;
  }, "healthy");
  const depegged = rows.filter((r) => r.status === "depeg");
  const unread = rows.filter((r) => r.status === "unknown");

  return {
    asOf: new Date().toISOString(),
    count: rows.length,
    rows,
    worst, // healthy | watch | unknown | depeg
    ...(unread.length ? { degraded: true, unreadable: unread.map((r) => r.symbol) } : {}),
    finding:
      depegged.length > 0
        ? `${depegged.map((r) => `${r.symbol} is ${r.deviationBps! < 0 ? "under" : "over"} peg by ${Math.abs(r.deviationBps!) / 100}% ($${r.priceUsd})`).join("; ")} — reprice anything denominated in it before trading.`
        : unread.length === rows.length
          ? "No stablecoin price could be read this call (DEX feed) — peg status UNKNOWN, not healthy. Re-check."
          : `All ${rows.length - unread.length} readable stablecoins are within ${DEPEG_BPS / 100}% of $1.00${unread.length ? ` (${unread.length} unread)` : ""}.`,
    thresholds: { watchBps: WATCH_BPS, depegBps: DEPEG_BPS },
    note: "Live DEX price vs the $1.00 peg for major USD-pegged stablecoins on Base (USDC, USDT, DAI, USDbC). EUR-pegged EURC is excluded on purpose — scoring it against the dollar would mismeasure it. A feed outage reads as 'unknown', never a healthy peg. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
