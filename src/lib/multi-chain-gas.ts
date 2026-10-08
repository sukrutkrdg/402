/**
 * Multi-chain gas — which chain is cheapest to operate on right now?
 *
 * bridge-route answers "how do I move funds to another chain"; this answers the
 * question before it — "which chain should I be on at all". It reads the live
 * gas price on each major EVM chain an agent uses and turns it into the USD cost
 * of the actions an agent actually does: a plain transfer and a DEX swap. An
 * agent deciding where to settle, or whether a chain is congested, gets one
 * ranked answer instead of five RPC calls and a spreadsheet.
 *
 * Gas is read straight from each chain's RPC; native-token prices come from a
 * single CoinGecko call. A chain whose gas or price could not be read is reported
 * as "unknown" and is excluded from the "cheapest" pick — never guessed, never
 * ranked on a number we do not have.
 */

import "server-only";
import { createPublicClient, http } from "viem";
import { base, arbitrum, optimism, polygon, mainnet } from "viem/chains";

/** Typical gas units for the two actions agents care about. */
const GAS_TRANSFER = 21_000n;
const GAS_SWAP = 150_000n;

interface ChainDef { name: string; id: number; rpc: string | undefined; chain: Parameters<typeof createPublicClient>[0]["chain"]; native: "ETH" | "POL" }
const CHAINS: ChainDef[] = [
  { name: "base", id: 8453, rpc: process.env.BASE_RPC_URL?.trim() || undefined, chain: base, native: "ETH" },
  { name: "arbitrum", id: 42161, rpc: undefined, chain: arbitrum, native: "ETH" },
  { name: "optimism", id: 10, rpc: undefined, chain: optimism, native: "ETH" },
  { name: "ethereum", id: 1, rpc: undefined, chain: mainnet, native: "ETH" },
  { name: "polygon", id: 137, rpc: "https://polygon-rpc.com", chain: polygon, native: "POL" },
];

async function nativePrices(): Promise<{ ETH: number | null; POL: number | null }> {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,polygon-ecosystem-token&vs_currencies=usd", { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { ethereum?: { usd?: number }; "polygon-ecosystem-token"?: { usd?: number } };
    return { ETH: j.ethereum?.usd ?? null, POL: j["polygon-ecosystem-token"]?.usd ?? null };
  } catch {
    return { ETH: null, POL: null };
  }
}

async function gasPriceOf(def: ChainDef): Promise<bigint | null> {
  try {
    const client = createPublicClient({ chain: def.chain, transport: http(def.rpc) });
    return await client.getGasPrice();
  } catch {
    return null;
  }
}

export async function multiChainGas(_params: Record<string, string>) {
  const [prices, ...gas] = await Promise.all([nativePrices(), ...CHAINS.map(gasPriceOf)]);

  const rows = CHAINS.map((def, i) => {
    const gp = gas[i];
    const price = def.native === "ETH" ? prices.ETH : prices.POL;
    const gweiStr = gp !== null ? +(Number(gp) / 1e9).toFixed(4) : null;
    const costUsd = (units: bigint) => (gp !== null && price !== null ? +((Number(gp * units) / 1e18) * price).toFixed(5) : null);
    const transferUsd = costUsd(GAS_TRANSFER);
    const swapUsd = costUsd(GAS_SWAP);
    return {
      chain: def.name,
      chainId: def.id,
      native: def.native,
      gasPriceGwei: gweiStr,
      transferUsd,
      swapUsd,
      readable: gp !== null && price !== null,
    };
  });

  const readable = rows.filter((r) => r.readable && r.swapUsd !== null);
  const unread = rows.filter((r) => !r.readable).map((r) => r.chain);
  const ranked = [...readable].sort((a, b) => (a.swapUsd as number) - (b.swapUsd as number));
  const cheapest = ranked[0] ?? null;
  const dearest = ranked[ranked.length - 1] ?? null;

  return {
    asOf: new Date().toISOString(),
    nativePrices: prices,
    chains: rows.sort((a, b) => (a.swapUsd ?? Infinity) - (b.swapUsd ?? Infinity)),
    cheapestForSwap: cheapest ? { chain: cheapest.chain, swapUsd: cheapest.swapUsd } : null,
    ...(unread.length ? { degraded: true, unreadable: unread } : {}),
    gasUnitsAssumed: { transfer: Number(GAS_TRANSFER), swap: Number(GAS_SWAP) },
    recommendation: cheapest
      ? `${cheapest.chain} is cheapest for a swap right now (~$${cheapest.swapUsd}${dearest && dearest.chain !== cheapest.chain ? ` vs ~$${dearest.swapUsd} on ${dearest.chain}` : ""}). Transfer ~$${cheapest.transferUsd}.${unread.length ? ` ${unread.join(", ")} could not be read — excluded.` : ""}`
      : "No chain's gas could be read this call — costs are UNKNOWN, not zero. Re-check.",
    note: "Live gas price per chain × typical action gas × native-token price = the USD cost of a transfer and a swap on each major EVM chain (base, arbitrum, optimism, ethereum, polygon). Gas units are typical estimates; a real swap varies by route. A chain we could not read is 'unknown', never ranked. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
