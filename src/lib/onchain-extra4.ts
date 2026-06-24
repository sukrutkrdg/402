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
  let raw: TokenProfile[];
  try {
    const res = await fetch("https://api.dexscreener.com/token-profiles/latest/v1", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`DexScreener responded ${res.status}`);
    raw = (await res.json()) as TokenProfile[];
  } catch (err) {
    throw new Error(`New-token feed unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error("New-token feed unavailable: unexpected response format");
  }

  const tokens = raw
    .filter((t) => t.chainId === "base" && typeof t.tokenAddress === "string")
    .slice(0, 20)
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
    source: "DexScreener token-profiles",
    checkedAt: new Date().toISOString(),
  };
}
