/**
 * Commodity data endpoints — the high-volume calls the x402 ecosystem buys most,
 * served as our own competitive versions.
 *
 * The crawler analysis showed DNS lookups, DeFi-TVL rankings and stablecoin
 * market data among the most-hammered services across sellers. These wrap public,
 * no-key upstreams (Cloudflare DoH, DefiLlama) with honest framing. A failed
 * upstream is surfaced, never returned as empty.
 */

import "server-only";

// ---------------------------------------------------------------------------
// dns-lookup — DNS records via Cloudflare DNS-over-HTTPS (no key)
// ---------------------------------------------------------------------------

const DNS_TYPES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28 };
const TYPE_NAME: Record<number, string> = Object.fromEntries(Object.entries(DNS_TYPES).map(([k, v]) => [v, k]));

export async function dnsLookup(params: Record<string, string>) {
  const name = (params.name || params.domain || params.host || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(name)) throw new Error("Provide a domain name (name=example.com)");
  const type = (params.type || "A").toUpperCase();
  if (!(type in DNS_TYPES)) throw new Error(`type must be one of ${Object.keys(DNS_TYPES).join(", ")}`);

  let res: Response;
  try {
    res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error("DNS resolver unreachable — not charged, retry shortly");
  }
  if (!res.ok) throw new Error(`DNS resolver responded ${res.status} — not charged`);
  const j = (await res.json()) as { Status?: number; Answer?: Array<{ name?: string; type?: number; TTL?: number; data?: string }> };
  const records = (j.Answer ?? []).map((a) => ({ type: a.type != null ? TYPE_NAME[a.type] ?? a.type : null, ttl: a.TTL ?? null, value: (a.data ?? "").replace(/^"|"$/g, "") }));

  return {
    name,
    queryType: type,
    status: j.Status === 0 ? "ok" : j.Status === 3 ? "nxdomain" : `dns-status-${j.Status}`,
    recordCount: records.length,
    records,
    note: "DNS records resolved via Cloudflare DNS-over-HTTPS. NXDOMAIN means the name does not exist; an empty A/AAAA with ok status means no address of that type. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// defi-tvl — top DeFi protocols by TVL (DefiLlama, no key)
// ---------------------------------------------------------------------------

/** Categories that are not DeFi protocols — excluded so "DeFi TVL" means DeFi. */
const NON_DEFI = new Set(["CEX", "Chain", "Bridge"]);

export async function defiTvl(params: Record<string, string>) {
  const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 50);
  const chain = (params.chain || "").trim();
  const category = (params.category || "").trim();

  let res: Response;
  try {
    res = await fetch("https://api.llama.fi/protocols", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new Error("DeFi data unreachable (DefiLlama) — not charged, retry shortly");
  }
  if (!res.ok) throw new Error(`DefiLlama responded ${res.status} — not charged`);
  const all = (await res.json()) as Array<{ name?: string; symbol?: string; category?: string; chains?: string[]; tvl?: number; change_1d?: number; change_7d?: number }>;

  const chainLc = chain.toLowerCase();
  const filtered = all
    .filter((p) => typeof p.tvl === "number" && p.tvl > 0 && !NON_DEFI.has(p.category ?? ""))
    .filter((p) => (category ? (p.category ?? "").toLowerCase() === category.toLowerCase() : true))
    .filter((p) => (chain ? (p.chains ?? []).some((c) => c.toLowerCase() === chainLc) : true))
    .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))
    .slice(0, limit)
    .map((p) => ({ name: p.name, symbol: p.symbol ?? null, category: p.category ?? null, tvlUsd: Math.round(p.tvl as number), change1dPct: p.change_1d ?? null, change7dPct: p.change_7d ?? null, chains: (p.chains ?? []).slice(0, 6) }));

  if (filtered.length === 0) throw new Error(`No DeFi protocols matched${chain ? ` chain=${chain}` : ""}${category ? ` category=${category}` : ""} — not charged`);

  return {
    count: filtered.length,
    ...(chain ? { chain } : {}),
    ...(category ? { category } : {}),
    protocols: filtered,
    note: `Top DeFi protocols by TVL (DefiLlama), CEX/Chain/Bridge excluded so this is DeFi. tvlUsd is the protocol's GLOBAL TVL; chain= filters to protocols ACTIVE on that chain, not their per-chain TVL. Not financial advice.`,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// stablecoin-mcap — total stablecoin market cap + top by circulating (DefiLlama)
// ---------------------------------------------------------------------------

export async function stablecoinMcap(params: Record<string, string>) {
  const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 30);
  let res: Response;
  try {
    res = await fetch("https://stablecoins.llama.fi/stablecoins?includePrices=true", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new Error("Stablecoin data unreachable (DefiLlama) — not charged, retry shortly");
  }
  if (!res.ok) throw new Error(`DefiLlama responded ${res.status} — not charged`);
  const j = (await res.json()) as { peggedAssets?: Array<{ name?: string; symbol?: string; pegType?: string; pegMechanism?: string; circulating?: Record<string, number>; price?: number | null }> };
  const assets = j.peggedAssets ?? [];
  const circOf = (a: { circulating?: Record<string, number> }) => Object.values(a.circulating ?? {}).reduce((s, v) => s + (Number(v) || 0), 0);

  const total = assets.reduce((s, a) => s + circOf(a), 0);
  const top = assets
    .map((a) => ({ name: a.name, symbol: a.symbol ?? null, pegType: a.pegType ?? null, mechanism: a.pegMechanism ?? null, circulatingUsd: Math.round(circOf(a)), price: a.price ?? null }))
    .sort((a, b) => b.circulatingUsd - a.circulatingUsd)
    .slice(0, limit);

  const depegged = top.filter((a) => a.pegType === "peggedUSD" && a.price != null && Math.abs((a.price as number) - 1) >= 0.02);

  return {
    totalMarketCapUsd: Math.round(total),
    totalMarketCapB: +(total / 1e9).toFixed(1),
    assetCount: assets.length,
    top,
    ...(depegged.length ? { depegWatch: depegged.map((a) => ({ symbol: a.symbol, price: a.price })) } : {}),
    note: "Total stablecoin market cap and the largest stablecoins by circulating supply (DefiLlama). circulatingUsd sums all chains. For a single Base-stablecoin peg check use stablecoin-peg. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
