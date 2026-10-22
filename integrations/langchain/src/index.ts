import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { BazaarClient, type BazaarClientOptions } from "./client";

/**
 * Creates a LangChain tool to call any x402-bazaar service.
 * @param options BazaarClientOptions (baseUrl, creditToken, signer)
 */
export function createX402BazaarTool(options: BazaarClientOptions = {}) {
  const client = new BazaarClient(options);

  return tool(
    async ({ service, params }: { service: string; params: Record<string, string> }) => {
      try {
        const result = await client.call(service, params);
        return typeof result === "string" ? result : JSON.stringify(result);
      } catch (error: any) {
        return `Error calling ${service}: ${error.message}`;
      }
    },
    {
      name: "x402_bazaar_call",
      description: "Call any x402 Bazaar service by id — 150+ pay-per-call APIs for agents. Check https://402.com.tr/api/catalog for available services.",
      schema: z.object({
        service: z.string().describe("Service id from the catalog, e.g. 'token-risk' or 'pre-trade-gate'"),
        params: z.record(z.string()).describe("Query parameters for the service (key-value strings)"),
      }),
    }
  );
}

export { BazaarClient, type BazaarClientOptions };
