/**
 * x402 Bazaar custom action for Coinbase AgentKit.
 *
 * Gives any AgentKit agent on Base a tool to fetch onchain data & AI reports
 * (token risk, wallet net worth, OFAC sanctions, prices, AI token/wallet
 * verdicts) — paid per call in USDC over x402. Use this alongside AgentKit's
 * own onchain action providers: the agent *knows what to act on* (x402 Bazaar)
 * and then *acts* (AgentKit wallet actions / Base MCP).
 */

import { customActionProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const key = process.env.AGENT_PRIVATE_KEY;
if (!key) throw new Error("Set AGENT_PRIVATE_KEY — a Base wallet holding USDC (gasless for the payer).");

const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const client = new x402Client();
client.register("eip155:8453", new ExactEvmScheme(account)); // Base mainnet
const pay = wrapFetchWithPayment(fetch, client);

const ORIGIN = process.env.X402_BAZAAR_ORIGIN || "https://402.com.tr";

export const x402BazaarAction = customActionProvider({
  name: "x402_bazaar",
  description:
    "Fetch onchain data or AI reports on Base from x402 Bazaar (43+ services). " +
    "Examples: service='ai-token-report' query='address=0x..' for a buy/avoid verdict; " +
    "service='wallet-networth' query='address=0x..'; service='sanctions' query='address=0x..'; " +
    "service='token-momentum' query='address=0x..'. Discover all services at /.well-known/x402. " +
    "Each call settles a tiny USDC micro-payment over x402 — no API keys.",
  schema: z.object({
    service: z.string().describe("Service id, e.g. ai-token-report, token-risk, wallet-networth, sanctions, token-momentum"),
    query: z.string().optional().describe("URL query string, e.g. address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  }),
  invoke: async (_walletProvider, { service, query }) => {
    const url = `${ORIGIN}/api/x402/${service}${query ? `?${query}` : ""}`;
    const res = await pay(url);
    return await res.text();
  },
});
