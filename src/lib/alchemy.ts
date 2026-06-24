/**
 * Alchemy-powered services (require ALCHEMY_API_KEY):
 *   nftFloor        — collection floor price (NFT API).
 *   walletPortfolio — full ERC-20 portfolio of an address with USD values
 *                     (Data/Portfolio API: balances + metadata + prices in one call).
 *
 * Both throw if the key is missing so x402 never charges without an answer.
 */

import "server-only";
import { getAddress, formatUnits } from "viem";

const BASE_NFT = "https://base-mainnet.g.alchemy.com/nft/v3";
const DATA_API = "https://api.g.alchemy.com/data/v1";

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

// ---------------------------------------------------------------------------
// NFT floor price
// ---------------------------------------------------------------------------

interface FloorMarket {
  floorPrice?: number;
  priceCurrency?: string;
  collectionUrl?: string;
  error?: string;
}

export async function nftFloor(params: Record<string, string>) {
  const contract = reqAddr(params.contract || params.address || "");
  const k = key();

  let data: { openSea?: FloorMarket; looksRare?: FloorMarket };
  try {
    const res = await fetch(`${BASE_NFT}/${k}/getFloorPrice?contractAddress=${contract}`, {
      signal: AbortSignal.timeout(8000),
    });
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
// Wallet portfolio (all ERC-20 tokens + USD)
// ---------------------------------------------------------------------------

interface AlchemyToken {
  tokenAddress?: string;
  tokenBalance?: string; // hex
  tokenMetadata?: { symbol?: string; name?: string; decimals?: number; logo?: string };
  tokenPrices?: Array<{ currency?: string; value?: string }>;
}

export async function walletPortfolio(params: Record<string, string>) {
  const address = reqAddr(params.address || "");
  const k = key();

  let tokens: AlchemyToken[];
  try {
    const res = await fetch(`${DATA_API}/${k}/assets/tokens/by-address`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addresses: [{ address, networks: ["base-mainnet"] }],
        withMetadata: true,
        withPrices: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Alchemy responded ${res.status}`);
    const j = (await res.json()) as { data?: { tokens?: AlchemyToken[] } };
    tokens = j.data?.tokens ?? [];
  } catch (err) {
    throw new Error(`Portfolio unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const holdings = tokens
    .map((t) => {
      const decimals = t.tokenMetadata?.decimals ?? 18;
      let balance = 0;
      try {
        balance = t.tokenBalance ? parseFloat(formatUnits(BigInt(t.tokenBalance), decimals)) : 0;
      } catch {
        balance = 0;
      }
      const usdPrice = parseFloat(
        t.tokenPrices?.find((p) => (p.currency ?? "").toLowerCase() === "usd")?.value ?? "",
      );
      const usdValue = Number.isFinite(usdPrice) ? +(balance * usdPrice).toFixed(2) : null;
      return {
        symbol: t.tokenMetadata?.symbol ?? null,
        name: t.tokenMetadata?.name ?? null,
        address: t.tokenAddress ?? null,
        balance: balance > 0 ? String(balance) : "0",
        usdValue,
      };
    })
    .filter((h) => parseFloat(h.balance) > 0)
    .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))
    .slice(0, 50);

  const totalUsd = +holdings.reduce((s, h) => s + (h.usdValue ?? 0), 0).toFixed(2);

  return {
    address,
    tokenCount: holdings.length,
    totalUsd,
    holdings,
    checkedAt: new Date().toISOString(),
  };
}
