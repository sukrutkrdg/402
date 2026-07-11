/**
 * Market & chain services built on free DexScreener + Base RPC data:
 *   tokenMomentum — price/volume change across h1/h6/h24 with a trend read.
 *   tokenInfo     — name, symbol, logo, websites & socials for a token.
 *   chainStatus   — live block, base fee, ETH price, simple-transfer cost in USD.
 */

import "server-only";
import { dexTokenPairs } from "./upstream-cache";
import { createPublicClient, http, formatGwei, formatEther } from "viem";
import { base } from "viem/chains";
import { getConfig } from "./config";
import { baseTransport } from "./base-transport";
import { tokenPrice } from "./onchain-extra";

const WETH = "0x4200000000000000000000000000000000000006";

interface DSPair {
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  priceChange?: { h1?: number; h6?: number; h24?: number };
  volume?: { h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number };
  info?: {
    imageUrl?: string;
    websites?: { url?: string }[];
    socials?: { type?: string; url?: string }[];
  };
}

function reqAddr(raw: string): string {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… token address");
  return v;
}

/** Fetch the token's best base-matched DEX pair (highest liquidity). */
async function bestBasePair(address: string): Promise<DSPair> {
  const pairs = ((await dexTokenPairs<DSPair>(address)) ?? []).filter(Boolean);
  if (pairs.length === 0) throw new Error("No DEX data for this token");
  const addrLc = address.toLowerCase();
  const baseM = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === addrLc);
  const pool = baseM.length ? baseM : pairs;
  return pool.reduce((t, p) => ((p.liquidity?.usd ?? 0) > (t.liquidity?.usd ?? 0) ? p : t), pool[0]);
}

export async function tokenMomentum(params: Record<string, string>) {
  const address = reqAddr(params.address);
  const p = await bestBasePair(address);
  const pc = p.priceChange ?? {};
  const vol = p.volume ?? {};
  const h24 = typeof pc.h24 === "number" ? pc.h24 : null;
  const trend =
    h24 === null ? "unknown" : h24 >= 10 ? "strong_up" : h24 >= 2 ? "up" : h24 <= -10 ? "strong_down" : h24 <= -2 ? "down" : "flat";
  return {
    address,
    symbol: p.baseToken?.symbol ?? null,
    priceUsd: p.priceUsd ?? null,
    priceChange: { h1: pc.h1 ?? null, h6: pc.h6 ?? null, h24: pc.h24 ?? null },
    volumeUsd: { h1: vol.h1 ?? null, h6: vol.h6 ?? null, h24: vol.h24 ?? null },
    liquidityUsd: p.liquidity?.usd ?? null,
    trend,
    checkedAt: new Date().toISOString(),
  };
}

export async function tokenInfo(params: Record<string, string>) {
  const address = reqAddr(params.address);
  const p = await bestBasePair(address);
  const info = p.info ?? {};
  return {
    address,
    name: p.baseToken?.name ?? null,
    symbol: p.baseToken?.symbol ?? null,
    imageUrl: typeof info.imageUrl === "string" ? info.imageUrl : null,
    websites: (info.websites ?? [])
      .map((w) => w.url)
      .filter((u): u is string => typeof u === "string" && u.startsWith("https://"))
      .slice(0, 5),
    socials: (info.socials ?? [])
      .filter((s) => s && typeof s.url === "string" && s.url.startsWith("https://"))
      .map((s) => ({ type: s.type ?? null, url: s.url as string }))
      .slice(0, 8),
    priceUsd: p.priceUsd ?? null,
    liquidityUsd: p.liquidity?.usd ?? null,
    checkedAt: new Date().toISOString(),
  };
}

export async function chainStatus(_params: Record<string, string>) {
  const c = createPublicClient({ chain: base, transport: baseTransport(8000) });
  let block, fees;
  try {
    [block, fees] = await Promise.all([c.getBlock({ blockTag: "latest" }), c.estimateFeesPerGas()]);
  } catch (err) {
    throw new Error(`Chain data unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const baseFee = block.baseFeePerGas ?? 0n;
  const priority = fees.maxPriorityFeePerGas ?? 0n;

  let ethUsd: number | null = null;
  try {
    const wp = await tokenPrice({ address: WETH });
    ethUsd = wp.priceUsd ? parseFloat(wp.priceUsd) : null;
  } catch {
    /* price optional */
  }

  const transferEth = Number(formatEther((baseFee + priority) * 21000n));
  const simpleTransferCostUsd = ethUsd !== null ? +(transferEth * ethUsd).toFixed(4) : null;

  return {
    blockNumber: String(block.number),
    baseFeeGwei: formatGwei(baseFee),
    maxPriorityFeeGwei: formatGwei(priority),
    ethPriceUsd: ethUsd,
    simpleTransferCostUsd,
    checkedAt: new Date().toISOString(),
  };
}
