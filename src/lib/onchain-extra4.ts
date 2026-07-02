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

// GeckoTerminal "new pools" — the FRESHEST Base launches (where honeypots live).
// Far richer for Base than DexScreener's profile/boost feeds. Returns TokenProfile
// shape so it merges with the others.
async function geckoNewPools(): Promise<TokenProfile[]> {
  const out: TokenProfile[] = [];
  for (const page of [1, 2]) {
    try {
      const res = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=${page}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) continue;
      const j = (await res.json()) as {
        data?: Array<{ attributes?: { name?: string }; relationships?: { base_token?: { data?: { id?: string } } } }>;
      };
      for (const p of j.data ?? []) {
        const id = p.relationships?.base_token?.data?.id ?? ""; // "base_0x…"
        const addr = id.includes("_") ? id.split("_")[1] : null;
        if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
          out.push({ chainId: "base", tokenAddress: addr, description: p.attributes?.name });
        }
      }
    } catch {
      /* best-effort per page */
    }
  }
  return out;
}

export async function newTokens(_params: Record<string, string>) {
  // Merge multiple free feeds — GeckoTerminal new-pools (freshest Base launches,
  // where scams live) + DexScreener profiles + boosts — to maximise the fresh
  // candidate set the scout screens. More fresh candidates = more scams caught.
  const dexFeeds = [
    "https://api.dexscreener.com/token-profiles/latest/v1",
    "https://api.dexscreener.com/token-boosts/latest/v1",
  ];
  const results = await Promise.allSettled([
    geckoNewPools(),
    ...dexFeeds.map(async (u) => {
      const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`DexScreener responded ${res.status}`);
      return (await res.json()) as TokenProfile[];
    }),
  ]);
  const raw: TokenProfile[] = results.flatMap((r) =>
    r.status === "fulfilled" && Array.isArray(r.value) ? r.value : [],
  );
  if (raw.length === 0) {
    throw new Error("New-token feed unavailable: all feeds returned nothing");
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
    .slice(0, 40)
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
    source: "GeckoTerminal new-pools + DexScreener profiles/boosts",
    checkedAt: new Date().toISOString(),
  };
}
