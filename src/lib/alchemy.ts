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

/** Wrapped ETH on Base — the pair DexScreener quotes native ETH through. */
const WETH: Address = "0x4200000000000000000000000000000000000006";

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

/**
 * Just the ERC-20/B20 contract addresses a wallet holds, via CDP Data API.
 * Used by the B20 portfolio guard to find B20 holdings without the full
 * price-enriched portfolio. Returns [] when CDP isn't configured (caller decides).
 */
export async function walletTokenContracts(address: Address): Promise<Address[]> {
  const cfg = getConfig();
  // Throw (not []) when the balance provider isn't configured — an empty list
  // would let b20-portfolio report "no B20 tokens" on a config/key failure,
  // which reads as falsely clean.
  if (!cfg.cdpApiKeyId || !cfg.cdpApiKeySecret) throw new Error("Token balance provider not configured");
  const cdp = new CdpClient({ apiKeyId: cfg.cdpApiKeyId, apiKeySecret: cfg.cdpApiKeySecret });
  // The API pages at 20 by default with unstable ordering — a wallet holding >20
  // tokens would get a different (and incomplete) token set on every call. Walk
  // the pages so B20 holdings past the first page are never silently missed.
  const out: Address[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await cdp.evm.listTokenBalances({ network: "base", address, pageSize: 100, pageToken });
    for (const b of res.balances ?? []) {
      const a = b.token?.contractAddress;
      if (a && /^0x[0-9a-fA-F]{40}$/.test(a)) out.push(a);
    }
    pageToken = res.nextPageToken ?? undefined;
    if (!pageToken || out.length >= 500) break;
  }
  return out.slice(0, 500);
}

export async function walletPortfolio(params: Record<string, string>) {
  const address = reqAddr(params.address || "") as Address;
  // The Alchemy key is fetched INSIDE the fallback, not here: the primary path
  // is CDP balances plus our own Base RPC and never touches Alchemy. Demanding
  // the key up front meant one cancelled subscription could kill an endpoint
  // that does not depend on it — which is exactly how the GoldRush cancellation
  // took out seven services on 2026-08-01.
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
      const balData = await rpc<TokenBalances>(key(), "alchemy_getTokenBalances", [address]);
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
      // Defaulting a failed decimals() read to 18 does not degrade the answer,
      // it invents one: on a 6-decimal token the balance comes out a million
      // times small, and because usdValue is balance x price, the dollar figure
      // is invented with it. Decimals are a property of the contract — when the
      // read fails there is no number here that is merely approximate.
      const decimals = dRes?.status === "success" ? Number(dRes.result) : null;
      const symbol = sRes?.status === "success" ? (sRes.result as string) : null;
      let bal: number | null = null;
      try {
        if (bRes?.status === "success" && decimals !== null) {
          bal = parseFloat(formatUnits(bRes.result as bigint, decimals));
        } else if (bRes?.status === "success" && decimals === null) {
          bal = null; // have the integer, not the scale
        } else {
          bal = 0; // the balance read itself failed — nothing held that we saw
        }
      } catch {
        bal = null;
      }
      const price = priceMap.get(addr.toLowerCase()) ?? KNOWN_USD[addr.toLowerCase()];
      const usdValue = bal !== null && price !== undefined ? +(bal * price).toFixed(2) : null;
      return {
        symbol,
        address: addr,
        balance: bal === null ? null : bal > 0 ? String(bal) : "0",
        ...(bal === null
          ? {
              balanceRaw: bRes?.status === "success" ? String(bRes.result) : null,
              decimalsUnknown: true,
              note: "Token decimals could not be read, so this balance cannot be scaled. balanceRaw is the unscaled integer.",
            }
          : {}),
        usdValue,
      };
    })
    // Dust is dropped; a holding we could not scale is not dust, and hiding it
    // would understate the wallet as quietly as mis-scaling it would.
    .filter((h) => h.balance === null || parseFloat(h.balance) > 1e-9)
    .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));

  let ethBalance = 0;
  try {
    ethBalance = parseFloat(formatEther(ethWei));
  } catch {
    ethBalance = 0;
  }

  const totalUsd = +holdings.reduce((s, h) => s + (h.usdValue ?? 0), 0).toFixed(2);
  // A holding with no usdValue contributes zero to the total, so the total is a
  // floor rather than a figure whenever any exist — whether the gap is a missing
  // price or a scale we could not read. Saying which lets a caller decide
  // whether the number is good enough to act on.
  const unvalued = holdings.filter((h) => h.usdValue === null).length;
  const unscaled = holdings.filter((h) => h.balance === null).length;

  return {
    address,
    eth: { balance: String(ethBalance) },
    tokenCount: holdings.length,
    totalUsd,
    totalUsdComplete: unvalued === 0,
    ...(unvalued > 0 ? { holdingsWithoutUsd: unvalued } : {}),
    ...(unscaled > 0 ? { holdingsWithUnknownDecimals: unscaled } : {}),
    holdings: holdings.slice(0, 50),
    source, // "alchemy" (full) or "curated" (fallback when Alchemy rate-limited)
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Wallet net worth, rebuilt on the portfolio read.
 *
 * The original implementation was a single Covalent `balances_v2` call. That
 * subscription was cancelled on 2026-08-01 and the endpoint now answers "credit
 * limit exceeded", so the same answer is assembled from sources we still have:
 * CDP token balances for discovery, our own Base RPC for the amounts, and
 * DexScreener for prices — the exact path `wallet-portfolio` already uses.
 *
 * One improvement over the old version: native ETH is priced and counted. The
 * Covalent-backed answer reported the ETH balance but valued only the tokens,
 * which understated every wallet that holds ETH — most of them.
 */
export async function walletNetworth(params: Record<string, string>) {
  const p = await walletPortfolio(params);
  const ethBalance = parseFloat(p.eth.balance) || 0;

  let ethUsd: number | null = null;
  if (ethBalance > 0) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${WETH}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const dj = (await res.json()) as { pairs?: Array<{ priceUsd?: string; liquidity?: { usd?: number } }> | null };
        const best = (dj.pairs ?? [])
          .filter((x) => Number.isFinite(parseFloat(x.priceUsd ?? "")))
          .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        if (best) ethUsd = +(ethBalance * parseFloat(best.priceUsd!)).toFixed(2);
      }
    } catch {
      /* ETH price optional — the answer still stands without it, and says so below */
    }
  }

  const holdings = [
    ...(ethBalance > 1e-9
      ? [{ symbol: "ETH", name: "Ether", address: null, native: true, balance: String(ethBalance), usdValue: ethUsd }]
      : []),
    // Carry the unreadable-scale marker through. Re-mapping without it would
    // hand the caller a null balance with nothing to explain it — the shape of
    // an answer that looks broken rather than one that is being careful.
    ...p.holdings.map((h) => ({
      symbol: h.symbol,
      name: null,
      address: h.address,
      native: false,
      balance: h.balance,
      ...("decimalsUnknown" in h ? { balanceRaw: h.balanceRaw, decimalsUnknown: true } : {}),
      usdValue: h.usdValue,
    })),
  ];
  const totalUsd = +holdings.reduce((s, h) => s + (h.usdValue ?? 0), 0).toFixed(2);
  const unpriced = holdings.filter((h) => h.usdValue === null).length;
  const unscaled = holdings.filter((h) => h.balance === null).length;

  return {
    address: p.address,
    totalUsd,
    tokenCount: holdings.length,
    holdings: holdings.slice(0, 50),
    // Named honestly: a total that excludes tokens nobody quotes is not the same
    // number as "everything this wallet owns".
    unpricedHoldings: unpriced,
    ...(unscaled > 0 ? { holdingsWithUnknownDecimals: unscaled } : {}),
    source: `${p.source}+dexscreener`,
    checkedAt: new Date().toISOString(),
    note:
      (unpriced > 0
        ? `${unpriced} holding(s) have no quoted market price and contribute 0 to the total. Unpriced tokens in a Base wallet are usually airdropped spam — they are listed rather than dropped, because deciding what is spam is the caller's call, not ours.`
        : "Every holding found had a quoted price.") +
      (unscaled > 0
        ? ` ${unscaled} holding(s) have a balance of null because the token's decimals() call failed — the raw integer is in balanceRaw, and neither a balance nor a value is guessed from it.`
        : ""),
  };
}

interface AlchemyOwnedNft {
  contract?: { address?: string; name?: string; symbol?: string; openSeaMetadata?: { floorPrice?: number; safelistRequestStatus?: string } };
  balance?: string;
}

/**
 * NFT collections a wallet holds, rebuilt on Alchemy's NFT API.
 *
 * Replaces the Covalent read that died with the GoldRush cancellation. Alchemy
 * returns NFTs one token at a time, so they are folded into collections here —
 * an agent asking "what does this wallet hold" wants the collections, not 400
 * token ids.
 *
 * Spam: Alchemy's own spam filter is applied at the query (`excludeFilters`),
 * which is what the old provider did server-side. It is a filter, not a
 * guarantee, and the response says so rather than implying the list is clean.
 */
export async function walletNfts(params: Record<string, string>) {
  const address = reqAddr(params.address || "");
  const k = key();
  // Built with URLSearchParams: the filter parameter is an array, and hand-rolling
  // `excludeFilters[]=` left unencoded brackets in the query string.
  const q = new URLSearchParams({ owner: address, withMetadata: "true", pageSize: "50" });
  q.append("excludeFilters[]", "SPAM");
  q.append("excludeFilters[]", "AIRDROPS");
  const url = `${NFT}/${k}/getNFTsForOwner?${q}`;

  let data: { ownedNfts?: AlchemyOwnedNft[]; totalCount?: number };
  try {
    const res = await fetchRetry(url);
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Alchemy ${res.status}${body ? ` — ${body}` : ""}`);
    }
    data = (await res.json()) as typeof data;
  } catch (err) {
    throw new Error(`NFT holdings unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const byContract = new Map<string, { name: string | null; symbol: string | null; address: string; count: number; floorEth: number | null; verified: boolean }>();
  for (const n of data.ownedNfts ?? []) {
    const addr = n.contract?.address?.toLowerCase();
    if (!addr) continue;
    const held = Number(n.balance ?? 1) || 1;
    const cur = byContract.get(addr);
    if (cur) {
      cur.count += held;
      continue;
    }
    byContract.set(addr, {
      name: n.contract?.name ?? null,
      symbol: n.contract?.symbol ?? null,
      address: addr,
      count: held,
      floorEth: typeof n.contract?.openSeaMetadata?.floorPrice === "number" ? n.contract.openSeaMetadata.floorPrice : null,
      verified: n.contract?.openSeaMetadata?.safelistRequestStatus === "verified",
    });
  }
  const collections = [...byContract.values()].sort((a, b) => (b.floorEth ?? 0) - (a.floorEth ?? 0) || b.count - a.count).slice(0, 30);

  return {
    address,
    collectionCount: collections.length,
    nftCount: collections.reduce((s, c) => s + c.count, 0),
    collections,
    truncated: (data.ownedNfts?.length ?? 0) >= 100,
    checkedAt: new Date().toISOString(),
    method:
      "Alchemy NFT API with the provider's spam and airdrop filters applied, folded into collections. Floor prices are OpenSea's where the collection has one; Base coverage is partial, so a null floor means unquoted, not worthless.",
    disclaimer: "Spam filtering is a provider heuristic, not a guarantee — an unwanted airdrop can still appear.",
  };
}
