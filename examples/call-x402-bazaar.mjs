#!/usr/bin/env node
/**
 * Minimal example: call a paid x402 Bazaar service from any agent.
 *
 * This is the exact payment flow an AI agent uses — the HTTP 402 → pay USDC on
 * Base → retry handshake is handled for you by @x402/fetch. The same code powers
 * the x402-bazaar-mcp server.
 *
 * Run:
 *   AGENT_PRIVATE_KEY=0x... node examples/call-x402-bazaar.mjs gas-oracle
 *   AGENT_PRIVATE_KEY=0x... node examples/call-x402-bazaar.mjs token-price "address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
 *
 * Requires deps from the repo (or: npm i @x402/fetch @x402/evm viem).
 */

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const KEY = process.env.AGENT_PRIVATE_KEY;
if (!KEY) {
  console.error("Set AGENT_PRIVATE_KEY — a Base wallet holding USDC (gas is paid by the facilitator).");
  process.exit(1);
}

const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`);
const client = new x402Client();
client.register("eip155:8453", new ExactEvmScheme(account)); // Base mainnet
const payingFetch = wrapFetchWithPayment(fetch, client);

const service = process.argv[2] || "gas-oracle";
const query = process.argv[3] || "";
const base = process.env.X402_BAZAAR_ORIGIN || "https://402.com.tr";
const url = `${base}/api/x402/${service}${query ? `?${query}` : ""}`;

console.log(`→ ${url}`);
const res = await payingFetch(url);
console.log(`← HTTP ${res.status}`);
console.log(await res.text());
