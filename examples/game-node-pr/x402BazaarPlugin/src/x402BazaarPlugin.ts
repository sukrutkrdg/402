import {
  GameWorker,
  GameFunction,
  ExecutableGameFunctionResponse,
  ExecutableGameFunctionStatus,
} from "@virtuals-protocol/game";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { BuilderCodeClientExtension } from "@x402/extensions/builder-code";
import { privateKeyToAccount } from "viem/accounts";

interface IX402BazaarPluginOptions {
  id?: string;
  name?: string;
  description?: string;
  credentials?: { privateKey?: string };
  origin?: string;
}

/**
 * x402 Bazaar plugin for G.A.M.E.
 *
 * Gives a GAME agent onchain intelligence on Base — token risk, wallet net
 * worth, OFAC sanctions, an AI token verdict and a market brief — each paid per
 * call in USDC over the x402 protocol (no API keys). The wallet key is used
 * locally to sign x402 payments and is never sent anywhere.
 */
class X402BazaarPlugin {
  private id: string;
  private name: string;
  private description: string;
  private privateKey?: string;
  private origin: string;
  private payingFetch: ReturnType<typeof wrapFetchWithPayment> | null = null;

  constructor(options: IX402BazaarPluginOptions = {}) {
    this.id = options.id || "x402_bazaar_worker";
    this.name = options.name || "x402 Bazaar Worker";
    this.description =
      options.description ||
      "Onchain intelligence for Base agents via x402 Bazaar — token risk, wallet net worth, OFAC sanctions, AI token verdicts and a market brief, each paid per call in USDC over x402 (no API keys).";
    this.privateKey = options.credentials?.privateKey || process.env.AGENT_PRIVATE_KEY;
    this.origin = (options.origin || process.env.X402_BAZAAR_ORIGIN || "https://402.com.tr").replace(/\/$/, "");
  }

  // Lazy paying-fetch — the key is needed only when a function actually runs.
  private getPayingFetch() {
    if (this.payingFetch) return this.payingFetch;
    if (!this.privateKey) {
      throw new Error(
        "x402 Bazaar: a Base wallet private key is required to pay for calls. Pass credentials.privateKey or set AGENT_PRIVATE_KEY.",
      );
    }
    const key = (this.privateKey.startsWith("0x") ? this.privateKey : `0x${this.privateKey}`) as `0x${string}`;
    const account = privateKeyToAccount(key);
    const client = new x402Client();
    client.register("eip155:8453", new ExactEvmScheme(account)); // Base mainnet
    client.registerExtension(new BuilderCodeClientExtension("x402_bazaar_cli"));
    this.payingFetch = wrapFetchWithPayment(fetch, client);
    return this.payingFetch;
  }

  private async call(service: string, query?: string): Promise<string> {
    const url = `${this.origin}/api/x402/${service}${query ? `?${query}` : ""}`;
    const res = await this.getPayingFetch()(url);
    const text = await res.text();
    if (!res.ok) throw new Error(text.slice(0, 200));
    return text;
  }

  private addressFunction(name: string, service: string, description: string) {
    return new GameFunction({
      name,
      description,
      args: [
        { name: "address", type: "string", description: "A 0x… Base address (token or wallet)" },
      ] as const,
      executable: async (args, logger) => {
        try {
          const address = (args.address || "").trim();
          if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
            return new ExecutableGameFunctionResponse(
              ExecutableGameFunctionStatus.Failed,
              "A valid 0x… Base address is required.",
            );
          }
          logger?.(`x402 Bazaar: ${service} ${address}`);
          const data = await this.call(service, `address=${address}`);
          return new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Done, data);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            `x402 Bazaar (${service}) failed: ${msg}`,
          );
        }
      },
    });
  }

  public get aiTokenReportFunction() {
    return this.addressFunction(
      "get_ai_token_report",
      "ai-token-report",
      "AI due-diligence verdict for a Base token (avoid→favorable) with a 0-100 safety score, risks and positives. Use before buying or interacting with a token.",
    );
  }

  public get tokenRiskFunction() {
    return this.addressFunction(
      "get_token_risk",
      "token-risk",
      "Fast token safety scan (honeypot, taxes, ownership, holder concentration) for a Base token.",
    );
  }

  public get walletNetworthFunction() {
    return this.addressFunction(
      "get_wallet_networth",
      "wallet-networth",
      "Full token portfolio and USD net worth for a Base wallet.",
    );
  }

  public get sanctionsFunction() {
    return this.addressFunction(
      "check_sanctions",
      "sanctions",
      "Screen a Base address against the OFAC sanctions list before sending funds or interacting.",
    );
  }

  public get marketBriefFunction() {
    return new GameFunction({
      name: "get_market_brief",
      description:
        "AI situational brief of the Base token market — mood, highlights, new & notable launches, cautions. Use for market context before trading.",
      args: [] as const,
      executable: async (_args, logger) => {
        try {
          logger?.("x402 Bazaar: ai-market-brief");
          const data = await this.call("ai-market-brief");
          return new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Done, data);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            `x402 Bazaar (market-brief) failed: ${msg}`,
          );
        }
      },
    });
  }

  public getWorker(): GameWorker {
    return new GameWorker({
      id: this.id,
      name: this.name,
      description: this.description,
      functions: [
        this.aiTokenReportFunction,
        this.tokenRiskFunction,
        this.walletNetworthFunction,
        this.sanctionsFunction,
        this.marketBriefFunction,
      ],
    });
  }
}

export default X402BazaarPlugin;
