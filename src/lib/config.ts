/**
 * Central configuration for the x402 Bazaar.
 *
 * Everything is driven by environment variables so the same code runs the
 * seller, the buyer and the attribution dashboard. See `.env.example`.
 */

import type { Network } from "@x402/core/types";

/** Base mainnet. x402 networks are CAIP-2 ids: `eip155:<chainId>`. */
export const NETWORK: Network = "eip155:8453";
export const CHAIN_ID = 8453;

/** USDC on Base mainnet — the asset x402 "exact" settles in by default. */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const BASESCAN_TX = (hash: string) => `https://basescan.org/tx/${hash}`;
export const BASESCAN_ADDR = (addr: string) => `https://basescan.org/address/${addr}`;

/** Coinbase Builder Code checker — paste a settlement tx hash to verify attribution. */
export const BUILDER_CODE_CHECKER = "https://buildercode-checker.vercel.app/";

/** Builder Code pattern enforced by ERC-8021 / the x402 extension. */
export const BUILDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;

export interface AppConfig {
  /** App builder code (`a`) — declared by the seller on every paid route. */
  appBuilderCode: string;
  /** Client builder code (`s`) — attached by the buyer to every payment. */
  clientBuilderCode: string;
  /** Address that receives the USDC payments (the seller's wallet). */
  payTo: string;
  /** Buyer signer key used by the demo buyer to pay. Server-only secret. */
  buyerPrivateKey: string | undefined;
  /** CDP API credentials for the Base mainnet facilitator. */
  cdpApiKeyId: string | undefined;
  cdpApiKeySecret: string | undefined;
  /** Optional RPC override for reading settlement calldata. */
  rpcUrl: string | undefined;
  /** Master switch for the demo buyer (`/api/buy`). Off → view-only showcase. */
  enableBuyer: boolean;
  /** Optional shared secret required to call `/api/buy` when set. */
  buyAccessToken: string | undefined;
}

export function getConfig(): AppConfig {
  return {
    appBuilderCode: process.env.APP_BUILDER_CODE?.trim() || "x402_bazaar",
    clientBuilderCode: process.env.CLIENT_BUILDER_CODE?.trim() || "x402_bazaar_cli",
    payTo: process.env.PAY_TO_ADDRESS?.trim() || "",
    buyerPrivateKey: process.env.BUYER_PRIVATE_KEY?.trim() || undefined,
    cdpApiKeyId: process.env.CDP_API_KEY_ID?.trim() || undefined,
    cdpApiKeySecret: process.env.CDP_API_KEY_SECRET?.trim() || undefined,
    rpcUrl: process.env.BASE_RPC_URL?.trim() || undefined,
    // Default ON locally; set ENABLE_BUYER=false on public deploys to disable spending.
    enableBuyer: process.env.ENABLE_BUYER?.trim().toLowerCase() !== "false",
    buyAccessToken: process.env.BUY_ACCESS_TOKEN?.trim() || undefined,
  };
}

/** Public Base App id for the `base:app_id` verification meta tag (safe to expose). */
export function getBaseAppId(): string | undefined {
  return process.env.NEXT_PUBLIC_BASE_APP_ID?.trim() || undefined;
}

/** True when the server is fully wired to settle real payments on mainnet. */
export function sellerReady(c: AppConfig): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!c.payTo) missing.push("PAY_TO_ADDRESS");
  if (!c.cdpApiKeyId) missing.push("CDP_API_KEY_ID");
  if (!c.cdpApiKeySecret) missing.push("CDP_API_KEY_SECRET");
  return { ok: missing.length === 0, missing };
}

/** True when the demo buyer can actually pay. */
export function buyerReady(c: AppConfig): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!c.buyerPrivateKey) missing.push("BUYER_PRIVATE_KEY");
  return { ok: missing.length === 0, missing };
}
