/**
 * x402 Bazaar Official SDK & ElizaOS Integration Provider.
 *
 * Provides client libraries for autonomous AI agents across TypeScript, Python,
 * and ElizaOS (ai16z) framework.
 */

export interface BazaarClientOptions {
  siteUrl?: string;
  privateKey?: `0x${string}`;
  builderCode?: string;
}

/**
 * 1-Line TypeScript SDK for AI Agents and Developers
 */
export class X402BazaarClient {
  private siteUrl: string;
  private privateKey?: `0x${string}`;
  private builderCode: string;

  constructor(options: BazaarClientOptions = {}) {
    this.siteUrl = options.siteUrl || "https://402.com.tr";
    this.privateKey = options.privateKey;
    this.builderCode = options.builderCode || "bc_pa0gqlv1";
  }

  /**
   * Execute an x402 Bazaar service.
   * If an HTTP 402 is returned, automatically handles the x402 payment protocol.
   */
  async call<T = unknown>(serviceId: string, params: Record<string, string> = {}): Promise<T> {
    const query = new URLSearchParams(params).toString();
    const url = `${this.siteUrl}/api/x402/${serviceId}${query ? `?${query}` : ""}`;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Builder-Code": this.builderCode,
    };

    const initialRes = await fetch(url, { headers });
    if (initialRes.status !== 402) {
      if (!initialRes.ok) {
        throw new Error(`API call failed with status ${initialRes.status}: ${await initialRes.text()}`);
      }
      return initialRes.json();
    }

    // HTTP 402 Payment Required: extract payment details
    const paymentHeader = initialRes.headers.get("x-payment-request") || (await initialRes.json());
    if (!this.privateKey) {
      throw new Error(
        `Service '${serviceId}' requires an x402 micropayment, but no privateKey was provided in X402BazaarClient.`
      );
    }

    // Settle via server-assisted buy endpoint or signed payment header
    const payRes = await fetch(`${this.siteUrl}/api/buy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceId, params }),
    });

    if (!payRes.ok) {
      const err = await payRes.json().catch(() => ({ error: "Settlement failed" }));
      throw new Error(`x402 settlement failed: ${err.error || payRes.statusText}`);
    }

    const payResult = await payRes.json();
    return (payResult.result?.data ?? payResult.result ?? payResult) as T;
  }
}

/**
 * ElizaOS (ai16z) Official Action Plugin for x402 Bazaar
 */
export const elizaX402Plugin = {
  name: "x402-bazaar",
  description: "Official x402 pay-per-call Web3 intelligence & risk tools for ElizaOS autonomous agents",
  actions: [
    {
      name: "PRE_TRADE_CHECK",
      similes: ["CHECK_TOKEN_SAFETY", "VERIFY_BASE_TOKEN", "ALPHA_SHIELD"],
      description: "Runs an instant pre-trade honeypot, B20 seizure, and slippage check before buying any Base token",
      handler: async (runtime: unknown, message: { content: { address: string } }) => {
        const client = new X402BazaarClient();
        return await client.call("pre-trade-alpha-shield", { address: message.content.address });
      },
    },
    {
      name: "CHECK_AGENT_CREDIT",
      similes: ["AGENT_FICO", "AGENT_REPUTATION", "CHECK_COUNTERPARTY"],
      description: "Evaluates an onchain AI agent's credit score, solvency, and postpaid credit limit on Base",
      handler: async (runtime: unknown, message: { content: { address: string } }) => {
        const client = new X402BazaarClient();
        return await client.call("agent-credit-score", { address: message.content.address });
      },
    },
    {
      name: "POLYMARKET_PREDICTION",
      similes: ["CHECK_ODDS", "MARKET_PROBABILITY"],
      description: "Queries live Polymarket CLOB odds and outcome probabilities for an event or topic",
      handler: async (runtime: unknown, message: { content: { query: string } }) => {
        const client = new X402BazaarClient();
        return await client.call("polymarket-odds", { query: message.content.query });
      },
    },
  ],
};

/**
 * Ready-to-use Python SDK snippet
 */
export const PYTHON_SDK_SNIPPET = `
import requests

class X402Bazaar:
    """Official Python Client for x402 Bazaar on Base."""
    def __init__(self, site_url="https://402.com.tr", builder_code="bc_pa0gqlv1"):
        self.site_url = site_url.rstrip("/")
        self.builder_code = builder_code

    def call(self, service_id: str, **params):
        url = f"{self.site_url}/api/x402/{service_id}"
        headers = {"X-Builder-Code": self.builder_code}
        r = requests.get(url, params=params, headers=headers)
        if r.status_code == 200:
            return r.json()
        elif r.status_code == 402:
            # Settle via x402 payment gateway
            pay_url = f"{self.site_url}/api/buy"
            pay_resp = requests.post(pay_url, json={"serviceId": service_id, "params": params})
            pay_resp.raise_for_status()
            res = pay_resp.json()
            return res.get("result", {}).get("data", res.get("result", res))
        r.raise_for_status()
`.trim();
