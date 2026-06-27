/**
 * x402 Bazaar plugin for the Virtuals GAME framework.
 *
 * Gives any GAME agent on Base onchain intelligence — token risk, wallet net
 * worth, OFAC sanctions, an AI token verdict, and a market brief — each paid
 * per call in USDC over x402 (no API keys). Drop the exported GameWorker into
 * your agent's workers, set AGENT_PRIVATE_KEY (a Base wallet with USDC), done.
 *
 *   import { x402BazaarWorker } from "./x402-bazaar-plugin.mjs";
 *   const agent = new GameAgent(API_KEY, { ...; workers: [x402BazaarWorker] });
 */

import {
  GameFunction,
  GameWorker,
  ExecutableGameFunctionResponse,
  ExecutableGameFunctionStatus,
} from "@virtuals-protocol/game";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { BuilderCodeClientExtension } from "@x402/extensions/builder-code";
import { privateKeyToAccount } from "viem/accounts";

const ORIGIN = process.env.X402_BAZAAR_ORIGIN || "https://402.com.tr";

// Lazy paying-fetch — the wallet is needed only when a function actually runs.
let _pay = null;
function pay() {
  if (_pay) return _pay;
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error("Set AGENT_PRIVATE_KEY — a Base wallet holding USDC.");
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  const client = new x402Client();
  client.register("eip155:8453", new ExactEvmScheme(account)); // Base mainnet
  client.registerExtension(new BuilderCodeClientExtension("x402_bazaar_cli"));
  _pay = wrapFetchWithPayment(fetch, client);
  return _pay;
}

async function callService(service, query) {
  const url = `${ORIGIN}/api/x402/${service}${query ? `?${query}` : ""}`;
  const res = await pay()(url);
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 200));
  return text;
}

// Helper to define a one-address service function quickly.
const addressFn = (name, service, description) =>
  new GameFunction({
    name,
    description,
    args: [{ name: "address", type: "string", description: "A 0x… Base address (token or wallet)" }],
    executable: async (args) => {
      try {
        const data = await callService(service, `address=${(args.address || "").trim()}`);
        return new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Done, data);
      } catch (e) {
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Failed,
          `x402 Bazaar (${service}) failed: ${e.message}`,
        );
      }
    },
  });

export const x402BazaarWorker = new GameWorker({
  id: "x402_bazaar",
  name: "x402 Bazaar — onchain intelligence",
  description:
    "Pay-per-call onchain data & AI reports for Base, via x402 Bazaar. Use these to know what to act on before acting.",
  functions: [
    addressFn(
      "x402_ai_token_report",
      "ai-token-report",
      "AI due-diligence verdict for a Base token (avoid→favorable) with safety score, risks and positives. Use before buying/interacting with a token.",
    ),
    addressFn(
      "x402_token_risk",
      "token-risk",
      "Fast token safety scan (honeypot, taxes, ownership, holders) for a Base token.",
    ),
    addressFn(
      "x402_wallet_networth",
      "wallet-networth",
      "Full token portfolio + USD net worth for a Base wallet.",
    ),
    addressFn(
      "x402_sanctions",
      "sanctions",
      "Screen a Base address against the OFAC sanctions list before sending funds or interacting.",
    ),
    new GameFunction({
      name: "x402_market_brief",
      description:
        "AI situational brief of the Base token market — mood, highlights, new & notable launches, cautions. Use for market context before trading.",
      args: [],
      executable: async () => {
        try {
          const data = await callService("ai-market-brief", "");
          return new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Done, data);
        } catch (e) {
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            `x402 Bazaar (market-brief) failed: ${e.message}`,
          );
        }
      },
    }),
  ],
});
