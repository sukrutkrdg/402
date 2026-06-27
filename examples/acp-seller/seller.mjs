/**
 * x402 Bazaar — ACP (Agent Commerce Protocol) seller service.
 *
 * Lets Virtuals agents discover, hire, and pay x402 Bazaar for onchain
 * intelligence (token risk, AI token report, wallet net worth, sanctions) via
 * ACP. This is a long-running REACTIVE listener: it waits for ACP jobs, accepts
 * them, produces the deliverable by calling x402 Bazaar, and delivers it — ACP
 * releases the USDC escrow to the seller agent on completion.
 *
 * PREREQUISITES (do Phase 1 first — see README):
 *   1. Register a provider agent at https://app.virtuals.io/acp/join
 *   2. Create a smart wallet + whitelist your dev wallet
 *   3. Set the env vars below
 *
 * Run on an ALWAYS-ON host (Railway/Render/VPS) — not serverless.
 */

import {
  GameAgent,
  GameFunction,
  ExecutableGameFunctionResponse,
  ExecutableGameFunctionStatus,
} from "@virtuals-protocol/game";
import AcpPlugin from "@virtuals-protocol/game-acp-plugin";
import AcpClient, { AcpContractClient, AcpJobPhases } from "@virtuals-protocol/acp-node";

const {
  GAME_API_KEY,
  SELLER_AGENT_WALLET_ADDRESS,
  WHITELISTED_WALLET_PRIVATE_KEY,
  SELLER_ENTITY_ID,
} = process.env;

const ORIGIN = (process.env.X402_BAZAAR_ORIGIN || "https://402.com.tr").replace(/\/$/, "");

// Produce a deliverable by calling x402 Bazaar. The ACP buyer pays us via
// escrow; we fulfil from the free tier or, for AI services, you can wire our
// buyer wallet (getPayingFetch) here. Kept simple: a plain fetch (works for the
// free tier; for paid AI services add an x402 paying-fetch like the other examples).
async function fetchFromBazaar(service, query) {
  const res = await fetch(`${ORIGIN}/api/x402/${service}${query ? `?${query}` : ""}`);
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 200));
  return text;
}

// The function the seller agent runs to produce + return the deliverable.
const produceTokenReport = new GameFunction({
  name: "produce_token_report",
  description:
    "Produce the x402 Bazaar deliverable for an ACP job: an AI token safety report for the requested Base token address.",
  args: [{ name: "address", type: "string", description: "Base token address from the buyer's request" }],
  executable: async (args) => {
    try {
      const address = (args.address || "").trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Failed,
          "Buyer must provide a valid 0x… Base token address.",
        );
      }
      const data = await fetchFromBazaar("token-risk", `address=${address}`);
      return new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Done, data);
    } catch (e) {
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        `x402 Bazaar fulfilment failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  },
});

let sellerAgent;

async function main() {
  if (!GAME_API_KEY || !SELLER_AGENT_WALLET_ADDRESS || !WHITELISTED_WALLET_PRIVATE_KEY || !SELLER_ENTITY_ID) {
    throw new Error(
      "Missing ACP env. Set GAME_API_KEY, SELLER_AGENT_WALLET_ADDRESS, WHITELISTED_WALLET_PRIVATE_KEY, SELLER_ENTITY_ID (see README + app.virtuals.io/acp/join).",
    );
  }

  const acpPlugin = new AcpPlugin({
    apiKey: GAME_API_KEY,
    acpClient: new AcpClient({
      acpContractClient: await AcpContractClient.build(
        WHITELISTED_WALLET_PRIVATE_KEY,
        Number(SELLER_ENTITY_ID),
        SELLER_AGENT_WALLET_ADDRESS,
      ),
      // Reactive: respond to each phase of an incoming job.
      onNewTask: async (job) => {
        let prompt = "";
        if (job.phase === AcpJobPhases.REQUEST && job.memos.find((m) => m.nextPhase === AcpJobPhases.NEGOTIATION)) {
          prompt = `A buyer requested an x402 Bazaar token-safety report:\n${JSON.stringify(job)}\nAccept the job (we can fulfil it). Then wait — do not produce the deliverable yet.`;
        } else if (job.phase === AcpJobPhases.TRANSACTION && job.memos.find((m) => m.nextPhase === AcpJobPhases.EVALUATION)) {
          prompt = `The buyer paid. Produce the deliverable with produce_token_report (use the address from the request) and deliver it:\n${JSON.stringify(job)}`;
        }
        if (!prompt) return;
        await sellerAgent.getWorkerById("acp_worker").runTask(prompt, { verbose: true });
        sellerAgent.log(`Responded to ACP job #${job.id}`);
      },
    }),
  });

  sellerAgent = new GameAgent(GAME_API_KEY, {
    name: "x402 Bazaar",
    goal: "Provide onchain token-safety intelligence to other agents and get paid via ACP.",
    description:
      "An ACP service provider that delivers x402 Bazaar token-safety reports. " +
      (await acpPlugin.getAcpState()),
    workers: [
      acpPlugin.getWorker({ functions: [produceTokenReport, acpPlugin.deliverJobFunction] }),
    ],
  });

  await sellerAgent.init();
  console.log("[x402-bazaar-acp] Seller agent live — listening for ACP jobs…");
}

main().catch((e) => {
  console.error("[x402-bazaar-acp] fatal:", e);
  process.exit(1);
});
