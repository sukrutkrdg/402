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
import { baseTransport } from "./base-transport";
import { CdpClient } from "@coinbase/cdp-sdk";

const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// Known USD pegs (DexScreener prices stablecoins poorly — they sit on the quote side).
const KNOWN_USD: Record<string, number> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 1, // USDC
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": 1, // USDbC
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": 1, // DAI
};

// Fallback token set (major Base tokens) when Alchemy is unavailable/rate-limited.
const CURATED: Address[] = [
  "0x4200000000000000000000000000000000000006", // WETH
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
  "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
  "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
  "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
];

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
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Alchemy ${res.status}${body ? ` — ${body}` : ""}`);
    }
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
  if (!openSea && !looksRare) {
    throw new Error(
      "No floor price found — Alchemy's floor feed is OpenSea/LooksRare based and has limited Base coverage. Make sure it's a Base NFT collection contract with active OpenSea listings.",
    );
  }

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
  const c = createPublicClient({ chain: base, transport: baseTransport(8000) });

  // 1) Token list. Prefer Alchemy (full list, single call); if it's rate-limited
  //    or down, fall back to a curated major-token set via our own RPC so the
  //    service still returns a useful answer.
  let tokenAddrs: Address[] = [];
  let source = "cdp";
  const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // ERC-7528 native placeholder
  try {
    // Primary: CDP Data API token balances (no Alchemy credits spent when this works).
    const cfg = getConfig();
    if (!cfg.cdpApiKeyId || !cfg.cdpApiKeySecret) throw new Error("no-cdp");
    const cdp = new CdpClient({ apiKeyId: cfg.cdpApiKeyId, apiKeySecret: cfg.cdpApiKeySecret });
    const res = await cdp.evm.listTokenBalances({ network: "base", address });
    tokenAddrs = (res.balances ?? [])
      .map((b) => b.token?.contractAddress)
      .filter((a): a is Address => !!a && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== NATIVE_SENTINEL)
      .slice(0, 20);
    if (tokenAddrs.length === 0) throw new Error("cdp-empty"); // fall through to Alchemy/curated
  } catch {
    // Fallback 1: Alchemy discovery.
    source = "alchemy";
    try {
      const balData = await rpc<TokenBalances>(k, "alchemy_getTokenBalances", [address]);
      tokenAddrs = (balData.tokenBalances ?? [])
        .filter((b) => b.contractAddress && b.tokenBalance && /[1-9a-f]/i.test(b.tokenBalance.slice(2)))
        .slice(0, 20)
        .map((b) => b.contractAddress as Address);
    } catch {
      // Fallback 2: curated major-token multicall.
      source = "curated";
      try {
        const balRes = await c.multicall({
          contracts: CURATED.map((a) => ({ address: a, abi: erc20Abi, functionName: "balanceOf", args: [address] }) as const),
          allowFailure: true,
        });
        tokenAddrs = CURATED.filter((_, i) => {
          const r = balRes[i];
          return r?.status === "success" && (r.result as bigint) > 0n;
        });
      } catch (err) {
        throw new Error(`Portfolio unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 2) balance + decimals + symbol via ONE multicall (our Base RPC) + native ETH.
  const c2 = c;
  let meta: Array<{ status: "success"; result: unknown } | { status: "failure"; error: Error }> = [];
  let ethWei = 0n;
  try {
    const [mc, eb] = await Promise.all([
      tokenAddrs.length
        ? c2.multicall({
            contracts: tokenAddrs.flatMap((a) => [
              { address: a, abi: erc20Abi, functionName: "balanceOf", args: [address] } as const,
              { address: a, abi: erc20Abi, functionName: "decimals" } as const,
              { address: a, abi: erc20Abi, functionName: "symbol" } as const,
            ]),
            allowFailure: true,
          })
        : Promise.resolve([]),
      c2.getBalance({ address }),
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

  const holdings = tokenAddrs
    .map((addr, i) => {
      const bRes = meta[i * 3];
      const dRes = meta[i * 3 + 1];
      const sRes = meta[i * 3 + 2];
      const decimals = dRes?.status === "success" ? Number(dRes.result) : 18;
      const symbol = sRes?.status === "success" ? (sRes.result as string) : null;
      let bal = 0;
      try {
        if (bRes?.status === "success") bal = parseFloat(formatUnits(bRes.result as bigint, decimals));
      } catch {
        bal = 0;
      }
      const price = priceMap.get(addr.toLowerCase()) ?? KNOWN_USD[addr.toLowerCase()];
      const usdValue = price !== undefined ? +(bal * price).toFixed(2) : null;
      return {
        symbol,
        address: addr,
        balance: bal > 0 ? String(bal) : "0",
        usdValue,
      };
    })
    .filter((h) => parseFloat(h.balance) > 1e-9) // drop dust
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
    source, // "alchemy" (full) or "curated" (fallback when Alchemy rate-limited)
    checkedAt: new Date().toISOString(),
  };
}
