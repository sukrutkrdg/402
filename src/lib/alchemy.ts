/**
 * Alchemy-powered services (require ALCHEMY_API_KEY):
 *   nftFloor        — collection floor price (NFT API).
 *   walletPortfolio — full ERC-20 portfolio with USD values, built on the cheap
 *                     core JSON-RPC (getTokenBalances + getTokenMetadata) so it
 *                     stays within the free tier, with USD from DexScreener.
 *
 * Both throw if the key is missing/unavailable so x402 never charges blindly.
 */

import "server-only";
import { createPublicClient, http, getAddress, formatUnits, formatEther, type Address } from "viem";
import { base } from "viem/chains";
import { getConfig } from "./config";

const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const NFT = "https://base-mainnet.g.alchemy.com/nft/v3";
const rpcUrl = (k: string) => `https://base-mainnet.g.alchemy.com/v2/${k}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function key(): string {
  const k = process.env.ALCHEMY_API_KEY?.trim();
  if (!k) throw new Error("NFT/portfolio not configured: set ALCHEMY_API_KEY");
  return k;
}
function reqAddr(raw: string): string {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… address");
  return getAddress(v);
}

/** fetch with one retry on 429/5xx (free-tier bursts). */
async function fetchRetry(url: string, opts: RequestInit = {}, retries = 1): Promise<Response> {
  for (let i = 0; ; i++) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts });
    } catch (e) {
      if (i < retries) {
        await sleep(700);
        continue;
      }
      throw e;
    }
    if ((res.status === 429 || res.status >= 500) && i < retries) {
      await sleep(800);
      continue;
    }
    return res;
  }
}

async function rpc<T>(k: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetchRetry(rpcUrl(k), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  if (!res.ok) throw new Error(`Alchemy responded ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message || "Alchemy RPC error");
  return j.result as T;
}

// ---------------------------------------------------------------------------
// NFT floor price
// ---------------------------------------------------------------------------

interface FloorMarket {
  floorPrice?: number;
  priceCurrency?: string;
  collectionUrl?: string;
}

export async function nftFloor(params: Record<string, string>) {
  const contract = reqAddr(params.contract || params.address || "");
  const k = key();

  let data: { openSea?: FloorMarket; looksRare?: FloorMarket };
  try {
    const res = await fetchRetry(`${NFT}/${k}/getFloorPrice?contractAddress=${contract}`);
    if (!res.ok) throw new Error(`Alchemy responded ${res.status}`);
    data = (await res.json()) as { openSea?: FloorMarket; looksRare?: FloorMarket };
  } catch (err) {
    throw new Error(`NFT floor unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pick = (m?: FloorMarket) =>
    m && typeof m.floorPrice === "number"
      ? { floorPrice: m.floorPrice, currency: m.priceCurrency ?? "ETH", url: m.collectionUrl ?? null }
      : null;
  const openSea = pick(data.openSea);
  const looksRare = pick(data.looksRare);
  if (!openSea && !looksRare) throw new Error("No floor price found for this collection");

  return {
    contract,
    openSea,
    looksRare,
    floorPriceEth: openSea?.floorPrice ?? looksRare?.floorPrice ?? null,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Wallet portfolio (cheap RPC balances + DexScreener USD)
// ---------------------------------------------------------------------------

interface TokenBalances {
  tokenBalances?: Array<{ contractAddress?: string; tokenBalance?: string }>;
}

export async function walletPortfolio(params: Record<string, string>) {
  const address = reqAddr(params.address || "") as Address;
  const k = key();

  // 1) Token list via Alchemy — a SINGLE call (no per-token fan-out → no 429 burst).
  let balData: TokenBalances;
  try {
    balData = await rpc<TokenBalances>(k, "alchemy_getTokenBalances", [address]);
  } catch (err) {
    throw new Error(`Portfolio unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const nonZero = (balData.tokenBalances ?? [])
    .filter((b) => b.contractAddress && b.tokenBalance && /[1-9a-f]/i.test(b.tokenBalance.slice(2)))
    .slice(0, 20);
  const tokenAddrs = nonZero.map((b) => b.contractAddress as Address);

  // 2) decimals + symbol via ONE multicall (our Base RPC) + native ETH balance.
  const c = createPublicClient({ chain: base, transport: http(getConfig().rpcUrl, { timeout: 8000 }) });
  let meta: Array<{ status: "success"; result: unknown } | { status: "failure"; error: Error }> = [];
  let ethWei = 0n;
  try {
    const [mc, eb] = await Promise.all([
      tokenAddrs.length
        ? c.multicall({
            contracts: tokenAddrs.flatMap((a) => [
              { address: a, abi: erc20Abi, functionName: "decimals" } as const,
              { address: a, abi: erc20Abi, functionName: "symbol" } as const,
            ]),
            allowFailure: true,
          })
        : Promise.resolve([]),
      c.getBalance({ address }),
    ]);
    meta = mc as typeof meta;
    ethWei = eb;
  } catch (err) {
    throw new Error(`Portfolio unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) USD via one batched DexScreener call.
  const priceMap = new Map<string, number>();
  try {
    const addrs = tokenAddrs.join(",");
    if (addrs) {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addrs}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const dj = (await res.json()) as {
          pairs?: Array<{ baseToken?: { address?: string }; priceUsd?: string; liquidity?: { usd?: number } }> | null;
        };
        const liqMap = new Map<string, number>();
        for (const p of dj.pairs ?? []) {
          const ba = p.baseToken?.address?.toLowerCase();
          const price = parseFloat(p.priceUsd ?? "");
          if (ba && Number.isFinite(price)) {
            const liq = p.liquidity?.usd ?? 0;
            if (!liqMap.has(ba) || liq > (liqMap.get(ba) ?? 0)) {
              liqMap.set(ba, liq);
              priceMap.set(ba, price);
            }
          }
        }
      }
    }
  } catch {
    /* USD optional */
  }

  const holdings = nonZero
    .map((b, i) => {
      const dRes = meta[i * 2];
      const sRes = meta[i * 2 + 1];
      const decimals = dRes?.status === "success" ? Number(dRes.result) : 18;
      const symbol = sRes?.status === "success" ? (sRes.result as string) : null;
      let bal = 0;
      try {
        bal = parseFloat(formatUnits(BigInt(b.tokenBalance as string), decimals));
      } catch {
        bal = 0;
      }
      const price = priceMap.get((b.contractAddress || "").toLowerCase());
      const usdValue = price !== undefined ? +(bal * price).toFixed(2) : null;
      return {
        symbol,
        address: b.contractAddress as string,
        balance: bal > 0 ? String(bal) : "0",
        usdValue,
      };
    })
    .filter((h) => parseFloat(h.balance) > 0)
    .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));

  let ethBalance = 0;
  try {
    ethBalance = parseFloat(formatEther(ethWei));
  } catch {
    ethBalance = 0;
  }

  const totalUsd = +holdings.reduce((s, h) => s + (h.usdValue ?? 0), 0).toFixed(2);

  return {
    address,
    eth: { balance: String(ethBalance) },
    tokenCount: holdings.length,
    totalUsd,
    holdings: holdings.slice(0, 50),
    checkedAt: new Date().toISOString(),
  };
}
