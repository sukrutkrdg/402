import { GameAgent } from "@virtuals-protocol/game";
import X402BazaarPlugin from "./x402BazaarPlugin";

// A Base wallet holding a little USDC; used locally to sign x402 payments.
const plugin = new X402BazaarPlugin({
  credentials: { privateKey: process.env.AGENT_PRIVATE_KEY },
});

const agent = new GameAgent(process.env.GAME_API_KEY as string, {
  name: "Base Safety Agent",
  goal: "Vet Base tokens and wallets for safety before acting.",
  description:
    "An agent that uses x402 Bazaar to pull token risk, wallet net worth, OFAC sanctions, AI token verdicts and a market brief — paying per call over x402.",
  workers: [plugin.getWorker()],
});

(async () => {
  await agent.init();
  await agent.run(60, { verbose: true });
})();
