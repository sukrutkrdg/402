/**
 * Robinhood Chain (chain 4663) stock-token reads — isolated, EVM via viem.
 *
 * Every authentic Robinhood tokenized stock is a beacon proxy with BYTE-IDENTICAL
 * code (verified on-chain: AAPL and TSLA share the same bytecode, pointing at the
 * one official Stock Token implementation). So a token whose code hash doesn't
 * match is NOT an official Robinhood issuance — an impersonator wearing the
 * ticker. That one `getBytecode` is the whole authenticity check, no key needed.
 * Nothing in the Base/NEAR/Solana/Arbitrum paths imports this.
 */
import "server-only";
import { createPublicClient, http, defineChain, keccak256, type Address } from "viem";

export const ROBINHOOD_CHAIN_ID = 4663;

/** keccak256 of the official Robinhood Stock Token beacon-proxy bytecode. */
const OFFICIAL_CODE_HASH = "0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630";

const RH_RPC = process.env.ROBINHOOD_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com";
const rhChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RH_RPC] } },
});
const client = createPublicClient({ chain: rhChain, transport: http() });

const ERC20 = [
  { name: "name", outputs: [{ type: "string" }], inputs: [], stateMutability: "view", type: "function" },
  { name: "symbol", outputs: [{ type: "string" }], inputs: [], stateMutability: "view", type: "function" },
  { name: "decimals", outputs: [{ type: "uint8" }], inputs: [], stateMutability: "view", type: "function" },
  { name: "totalSupply", outputs: [{ type: "uint256" }], inputs: [], stateMutability: "view", type: "function" },
] as const;

export interface RhStock {
  /** Code hash matches Robinhood's official Stock Token — an authentic issuance. */
  verified: boolean;
  /** True when there's a contract at the address at all. */
  isContract: boolean;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  supply: number | null;
}

export interface RhMarket {
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  pool: string | null;
}

/** Tokenized-stock DEX price/liquidity/volume via GeckoTerminal (keyless). Secondary. */
export async function rhMarket(address: string): Promise<RhMarket | null> {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${address}/pools?page=1`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { attributes?: Record<string, unknown> }[] };
    const a = (j.data ?? [])[0]?.attributes;
    if (!a) return { priceUsd: null, liquidityUsd: null, volume24hUsd: null, pool: null };
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      priceUsd: num(a.base_token_price_usd),
      liquidityUsd: num(a.reserve_in_usd),
      volume24hUsd: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
      pool: typeof a.name === "string" ? a.name : null,
    };
  } catch {
    return null;
  }
}

/** Read a Robinhood Chain token and verify it's an authentic Stock Token. null = RPC failure. */
export async function readRhStock(address: string): Promise<RhStock | null> {
  try {
    const addr = address as Address;
    const code = await client.getBytecode({ address: addr });
    if (!code || code === "0x") {
      return { verified: false, isContract: false, name: null, symbol: null, decimals: null, supply: null };
    }
    const verified = keccak256(code) === OFFICIAL_CODE_HASH;
    const [name, symbol, decimals, supply] = await Promise.all([
      client.readContract({ address: addr, abi: ERC20, functionName: "name" }).catch(() => null),
      client.readContract({ address: addr, abi: ERC20, functionName: "symbol" }).catch(() => null),
      client.readContract({ address: addr, abi: ERC20, functionName: "decimals" }).catch(() => null),
      client.readContract({ address: addr, abi: ERC20, functionName: "totalSupply" }).catch(() => null),
    ]);
    const dec = typeof decimals === "number" ? decimals : 18;
    return {
      verified,
      isContract: true,
      name: typeof name === "string" ? name : null,
      symbol: typeof symbol === "string" ? symbol : null,
      decimals: dec,
      supply: typeof supply === "bigint" ? Number(supply) / 10 ** dec : null,
    };
  } catch {
    return null;
  }
}
