/**
 * Holder Forensics — who really holds this token, and should that worry you.
 *
 * Goes past "top-10 = X%" to classify the holder base: how much the CREATOR and
 * OWNER still hold, which top holders are infrastructure (LP / CEX / bridge —
 * benign) versus unlabelled wallets (the concentration that actually matters),
 * and whether a single non-infra wallet could dump the price. Distinguishing
 * benign vs dangerous concentration is the analysis competitors skip.
 *
 * Free upstream (GoPlus) → stays in the standard tier.
 */

import "server-only";
import { getAddress } from "viem";

interface GpHolder {
  address?: string;
  tag?: string;
  is_contract?: number | boolean;
  is_locked?: number | boolean;
  percent?: string | number;
}
type Gp = Record<string, unknown> & {
  holders?: GpHolder[];
  lp_holders?: GpHolder[];
  holder_count?: string | number;
  creator_address?: string;
  creator_percent?: string | number;
  owner_address?: string;
  owner_percent?: string | number;
};

const BURN = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

function reqAddr(raw: string): string {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… token address");
  return getAddress(v);
}
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const isTrue = (v: unknown) => v === 1 || v === "1" || v === true;

// Heuristic: does the tag look like known infrastructure (benign concentration)?
function isInfra(tag?: string): boolean {
  const t = (tag || "").toLowerCase();
  if (!t) return false;
  return /uniswap|aerodrome|pancake|sushi|pool|lp|dex|cex|binance|coinbase|okx|bridge|lock|null|burn|team finance|unicrypt|gnosis|safe/.test(t);
}

export async function holderForensics(params: Record<string, string>) {
  const address = reqAddr(params.address || "");

  let gp: Gp | undefined;
  try {
    const res = await fetch(
      `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address}`,
      { signal: AbortSignal.timeout(9000) },
    );
    if (!res.ok) throw new Error(`GoPlus responded ${res.status}`);
    const j = (await res.json()) as { result?: Record<string, Gp> };
    gp = j.result?.[address.toLowerCase()];
  } catch (err) {
    throw new Error(`Holder data unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!gp || Object.keys(gp).length === 0) throw new Error("No holder data for this token");

  const holdersRaw = Array.isArray(gp.holders) ? gp.holders : [];
  const holderCount = gp.holder_count !== undefined ? Number(gp.holder_count) : null;
  const creatorPct = num(gp.creator_percent) * 100;
  const ownerPct = num(gp.owner_percent) * 100;

  // Classify each top holder.
  const classified = holdersRaw.slice(0, 10).map((h) => {
    const addr = (h.address ?? "").toLowerCase();
    const pct = num(h.percent) * 100;
    const burn = BURN.has(addr);
    const infra = isInfra(h.tag) || (isTrue(h.is_contract) && isTrue(h.is_locked));
    let kind: "burn" | "infra" | "contract" | "wallet" = "wallet";
    if (burn) kind = "burn";
    else if (infra) kind = "infra";
    else if (isTrue(h.is_contract)) kind = "contract";
    return { address: h.address ?? null, percent: +pct.toFixed(2), tag: h.tag || null, kind };
  });

  const top10Pct = +classified.reduce((s, h) => s + h.percent, 0).toFixed(2);
  // The concentration that actually matters: unlabelled wallets + unknown contracts,
  // excluding burn and known infrastructure (LP/CEX/locks).
  const risky = classified.filter((h) => h.kind === "wallet" || h.kind === "contract");
  const riskyConcentration = +risky.reduce((s, h) => s + h.percent, 0).toFixed(2);
  const largestNonInfra = risky.reduce((m, h) => Math.max(m, h.percent), 0);

  const flags: string[] = [];
  if (creatorPct >= 5) flags.push(`creator_holds_${creatorPct.toFixed(1)}pct`);
  if (ownerPct >= 5) flags.push(`owner_holds_${ownerPct.toFixed(1)}pct`);
  if (largestNonInfra >= 20) flags.push("single_wallet_over_20pct");
  else if (largestNonInfra >= 10) flags.push("single_wallet_over_10pct");
  if (riskyConcentration >= 50) flags.push("majority_in_few_wallets");
  if (holderCount !== null && holderCount < 50) flags.push("very_few_holders");

  const level =
    largestNonInfra >= 20 || riskyConcentration >= 50 || creatorPct >= 20
      ? "high"
      : largestNonInfra >= 10 || riskyConcentration >= 30 || creatorPct >= 5
        ? "medium"
        : "low";

  return {
    address,
    holderCount,
    creatorPercent: +creatorPct.toFixed(2),
    ownerPercent: +ownerPct.toFixed(2),
    top10Percent: top10Pct,
    riskyConcentrationPercent: riskyConcentration, // excludes LP/CEX/burn — the real dump risk
    largestNonInfraPercent: +largestNonInfra.toFixed(2),
    topHolders: classified, // each tagged burn | infra | contract | wallet
    concentrationRisk: level, // low | medium | high
    flags,
    note: "Separates benign concentration (LP/CEX/burn) from the wallets that could actually dump. Heuristic tagging; not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
