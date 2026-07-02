/**
 * New Token Scanner — recently listed/profiled tokens on Base.
 *
 * Uses the free DexScreener token-profiles feed (latest profiled tokens across
 * chains), filtered to Base. Great for discovery bots hunting fresh launches.
 * Throws on upstream failure so x402 doesn't charge for an empty answer.
 */

import "server-only";

interface TokenProfile {
  chainId?: string;
  tokenAddress?: string;
  description?: string;
  url?: string;
  icon?: string;
  links?: Array<{ type?: string; label?: string; url?: string }>;
}

export async function newTokens(_params: Record<string, string>) {
  // Pull from BOTH free DexScreener feeds — profiles (listed) + boosts (promoted)
  // — to widen the Base candidate set the scout screens. More candidates = more
  // scams caught for the on-chain registry.
  const feeds = [
    "https://api.dexscreener.com/token-profiles/latest/v1",
    "https://api.dexscreener.com/token-boosts/latest/v1",
  ];
  const results = await Promise.allSettled(
    feeds.map(async (u) => {
      const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`DexScreener responded ${res.status}`);
      return (await res.json()) as TokenProfile[];
    }),
  );
  const raw: TokenProfile[] = results.flatMap((r) =>
    r.status === "fulfilled" && Array.isArray(r.value) ? r.value : [],
  );
  if (raw.length === 0) {
    throw new Error("New-token feed unavailable: both DexScreener feeds returned nothing");
  }

  const seen = new Set<string>();
  const tokens = raw
    .filter((t) => t.chainId === "base" && typeof t.tokenAddress === "string")
    .filter((t) => {
      const a = (t.tokenAddress || "").toLowerCase();
      if (seen.has(a)) return false;
      seen.add(a);
      return true;
    })
    .slice(0, 30)
    .map((t) => ({
      tokenAddress: t.tokenAddress ?? null,
      description:
        typeof t.description === "string" ? t.description.trim().slice(0, 160) || null : null,
      url: typeof t.url === "string" && t.url.startsWith("https://") ? t.url : null,
      links: Array.isArray(t.links)
        ? t.links
            .map((l) => l.url)
            .filter((u): u is string => typeof u === "string" && u.startsWith("https://"))
            .slice(0, 5)
        : [],
    }));

  return {
    chain: "base",
    count: tokens.length,
    tokens,
    source: "DexScreener token-profiles + boosts",
    checkedAt: new Date().toISOString(),
  };
}
