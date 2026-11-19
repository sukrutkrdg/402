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
