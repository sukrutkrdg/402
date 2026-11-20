/**
 * SPL token read helpers — plain fetch, isolated. The mint account (via RPC
 * jsonParsed) is the ground truth for mint/freeze authority, the token program
 * (classic vs Token-2022) and Token-2022 extensions. RugCheck + Jupiter are
 * corroborating, key-less sources. All degrade to null (secondary) except the
 * mint read, which is the gating truth and throws upward on failure.
 */
import "server-only";
import { solanaRpc } from "./rpc";

/** Token-2022 program id — a mint owned by this carries TLV extensions. */
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface SplMint {
  program: "spl-token" | "spl-token-2022";
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  supply: string;
  /** Token-2022 extensions, as the RPC parses them (e.g. permanentDelegate, transferHook…). */
  extensions: { type: string; state?: unknown }[];
}

interface ParsedMint {
  value: {
    owner: string;
    data: { parsed?: { type?: string; info?: Record<string, unknown> } };
  } | null;
}

/** Read the mint account. This is the GATING truth — throws if it can't be read. */
export async function readSplMint(mint: string): Promise<SplMint> {
  const r = await solanaRpc<ParsedMint>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const v = r?.value;
  if (!v || v.data?.parsed?.type !== "mint") throw new Error("Not an SPL mint, or unreadable");
  const info = v.data.parsed.info ?? {};
  const extRaw = info.extensions as Array<{ extension?: string; state?: unknown }> | undefined;
  return {
    program: v.owner === TOKEN_2022 ? "spl-token-2022" : "spl-token",
    mintAuthority: (info.mintAuthority as string | null) ?? null,
    freezeAuthority: (info.freezeAuthority as string | null) ?? null,
    decimals: Number(info.decimals ?? 0),
    supply: String(info.supply ?? "0"),
    extensions: Array.isArray(extRaw)
      ? extRaw.map(e => ({ type: String(e.extension ?? "unknown"), state: e.state }))
      : [],
  };
}

export interface RugcheckSummary {
  scoreNormalised: number | null;
  lpLockedPct: number | null;
  risks: { name: string; level: string }[];
}

/** RugCheck aggregate verdict. Secondary — returns null on any failure (not fatal). */
export async function rugcheckSummary(mint: string): Promise<RugcheckSummary | null> {
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      score_normalised?: number;
      lpLockedPct?: number;
      risks?: Array<{ name?: string; level?: string }>;
    };
    return {
      scoreNormalised: typeof j.score_normalised === "number" ? j.score_normalised : null,
      lpLockedPct: typeof j.lpLockedPct === "number" ? j.lpLockedPct : null,
      risks: Array.isArray(j.risks) ? j.risks.map(r => ({ name: String(r.name ?? ""), level: String(r.level ?? "") })) : [],
    };
  } catch {
    return null;
  }
}

/** Can you SELL this token back to USDC? No route ⇒ unsellable (honeypot/illiquid). */
export async function jupiterSell(mint: string, decimals: number): Promise<{ sellable: boolean; priceImpactPct: number | null } | null> {
  if (mint === SOL_USDC) return { sellable: true, priceImpactPct: 0 };
  try {
    const amount = (10n ** BigInt(Math.min(Math.max(decimals, 0), 12))).toString(); // ~1 token, a route probe
    const res = await fetch(
      `https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${SOL_USDC}&amount=${amount}&slippageBps=300`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return { sellable: false, priceImpactPct: null };
    const j = (await res.json()) as { outAmount?: string; priceImpactPct?: string; routePlan?: unknown[] };
    const ok = Boolean(j?.outAmount && Array.isArray(j.routePlan) && j.routePlan.length > 0);
    return { sellable: ok, priceImpactPct: ok && j.priceImpactPct != null ? Number(j.priceImpactPct) : null };
  } catch {
    return null;
  }
}

export interface TopHolders {
  /** % of supply held by the 10 largest token accounts (includes pools/CEX — a raw concentration signal). */
  top10Pct: number | null;
  /** The single largest account's % of supply. */
  topPct: number | null;
  accounts: { address: string; pct: number }[];
}

/** Top-holder concentration via getTokenLargestAccounts (keyless RPC). Secondary. */
export async function splTopHolders(mint: string, supplyRaw: string): Promise<TopHolders | null> {
  try {
    const r = await solanaRpc<{ value?: { address: string; amount: string }[] }>("getTokenLargestAccounts", [mint]);
    const supply = Number(supplyRaw);
    if (!r?.value?.length || !Number.isFinite(supply) || supply <= 0) return null;
    const accounts = r.value.map(a => ({ address: a.address, pct: (Number(a.amount) / supply) * 100 }));
    return {
      top10Pct: accounts.slice(0, 10).reduce((n, a) => n + a.pct, 0),
      topPct: accounts[0]?.pct ?? null,
      accounts: accounts.slice(0, 10),
    };
  } catch {
    return null;
  }
}

export interface DexMarket {
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  fdvUsd: number | null;
  pairs: number;
  topPairUrl: string | null;
}

/** Price / liquidity / 24h volume / FDV via DexScreener (keyless). Secondary. */
export async function dexscreenerMarket(mint: string): Promise<DexMarket | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      pairs?: Array<{ priceUsd?: string; liquidity?: { usd?: number }; volume?: { h24?: number }; fdv?: number; url?: string }>;
    };
    const pairs = Array.isArray(j.pairs) ? j.pairs : [];
    if (!pairs.length) return { priceUsd: null, liquidityUsd: null, volume24hUsd: null, fdvUsd: null, pairs: 0, topPairUrl: null };
    const top = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    return {
      priceUsd: top.priceUsd != null ? Number(top.priceUsd) : null,
      liquidityUsd: top.liquidity?.usd ?? null,
      volume24hUsd: top.volume?.h24 ?? null,
      fdvUsd: top.fdv ?? null,
      pairs: pairs.length,
      topPairUrl: top.url ?? null,
    };
  } catch {
    return null;
  }
}

export interface NewPool {
  mint: string;
  name: string;
  createdAt: string;
  ageMinutes: number;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceUsd: number | null;
  /** pump.fun launch (mint ends in "pump"). */
  isPumpFun: boolean;
}

/** Freshly-created Solana DEX pools (GeckoTerminal, keyless). Secondary. */
export async function solanaNewPools(limit = 15): Promise<NewPool[] | null> {
  try {
    const res = await fetch("https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      data?: Array<{ attributes?: Record<string, unknown>; relationships?: { base_token?: { data?: { id?: string } } } }>;
    };
    const now = Date.now();
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return (j.data ?? [])
      .map((p) => {
        const a = p.attributes ?? {};
        const mint = String(p.relationships?.base_token?.data?.id ?? "").replace(/^solana_/, "");
        const createdAt = String(a.pool_created_at ?? "");
        return {
          mint,
          name: String(a.name ?? ""),
          createdAt,
          ageMinutes: createdAt ? Math.round((now - Date.parse(createdAt)) / 60000) : -1,
          liquidityUsd: num(a.reserve_in_usd),
          volume24hUsd: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
          priceUsd: num(a.base_token_price_usd),
          isPumpFun: /pump$/i.test(mint),
        };
      })
      .filter((p) => p.mint)
      .slice(0, limit);
  } catch {
    return null;
  }
}

/** Jupiter Shield security warnings (freeze/mint authority, unverified, new…). Secondary. */
export async function jupiterShield(mint: string): Promise<string[] | null> {
  try {
    const res = await fetch(`https://lite-api.jup.ag/ultra/v1/shield?mints=${mint}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { warnings?: Record<string, Array<string | { type?: string; name?: string }>> };
    const arr = j?.warnings?.[mint];
    return Array.isArray(arr) ? arr.map(w => (typeof w === "string" ? w : w.type ?? w.name ?? "warning")) : [];
  } catch {
    return null;
  }
}
