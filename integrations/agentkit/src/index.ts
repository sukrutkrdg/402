/**
 * x402 Bazaar actions for Coinbase AgentKit — check, then act.
 *
 *   const agentkit = await AgentKit.from({
 *     walletProvider,
 *     actionProviders: [x402BazaarActionProvider({ creditToken: process.env.X402_CREDIT_TOKEN })],
 *   });
 *
 * Calls are paid with the credit token if given, else per call over x402 from
 * the AgentKit wallet itself. Swaps are executed by that wallet; nothing is
 * held by x402 Bazaar.
 */

import { z } from "zod";
import { ActionProvider, CreateAction, EvmWalletProvider, type Network } from "@coinbase/agentkit";
import { encodeFunctionData, erc20Abi } from "viem";
import { BazaarClient, baseOriginToken, type BaseSwapQuote, type NearSwapQuote } from "./client.js";

export { BazaarClient } from "./client.js";

const PreTradeSchema = z
  .object({
    chain: z.enum(["base", "near"]).describe("Where the token lives: base (0x… address) or near (a NEAR token account like usdt.tether-token.near)"),
    token: z.string().describe("The token to check: a 0x… address on Base, or a NEAR token account"),
    sizeUsd: z.number().positive().optional().describe("Trade size in USD (default 1000 on Base, 100 on NEAR)"),
  })
  .strip();

const BaseSwapSchema = z
  .object({
    sell: z.string().describe("Token to sell: ETH, USDC, WETH, cbBTC, AERO… or a 0x… address on Base"),
    buy: z.string().describe("Token to buy: same forms as sell"),
    amount: z.string().describe("Amount to sell in whole units, e.g. \"25\" or \"0.01\""),
    slippageBps: z.number().int().min(1).max(1000).optional().describe("Slippage tolerance in basis points (default 100 = 1%)"),
  })
  .strip();

const CrossChainSchema = z
  .object({
    from: z.string().describe("Asset you pay with: USDC (on NEAR), NEAR, USDC@base, ETH@base, BTC@btc, SOL@sol… or a NEAR token account"),
    to: z.string().describe("Asset you want, same forms"),
    amount: z.string().describe("Amount of the paying asset in whole units"),
    recipient: z.string().describe("Address on the destination chain that receives the output"),
    refundTo: z.string().optional().describe("Address on the origin chain for a refund (default: this wallet, when paying from Base)"),
  })
  .strip();

const StatusSchema = z.object({ depositAddress: z.string().describe("The deposit address the cross-chain swap returned") }).strip();

const CallSchema = z
  .object({
    service: z.string().describe("Service id from https://402.com.tr/api/catalog, e.g. token-risk, near-portfolio, web-extract"),
    params: z.record(z.string()).describe("Query parameters for that service"),
  })
  .strip();

export interface X402BazaarOptions {
  /** Prepaid credit token (ck_…). Without it, each call is paid over x402 from the AgentKit wallet. */
  creditToken?: string;
  baseUrl?: string;
}

export class X402BazaarActionProvider extends ActionProvider<EvmWalletProvider> {
  constructor(private options: X402BazaarOptions = {}) {
    super("x402bazaar", []);
  }

  private client(wallet: EvmWalletProvider): BazaarClient {
    return new BazaarClient({
      baseUrl: this.options.baseUrl,
      creditToken: this.options.creditToken,
      signer: {
        address: wallet.getAddress() as `0x${string}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signTypedData: (td) => wallet.signTypedData(td as any) as Promise<`0x${string}`>,
      },
    });
  }

  @CreateAction({
    name: "pre_trade_check",
    description: `Check a token BEFORE buying it — returns GO / HOLD / STOP with reasons.
On Base: honeypot and sell-tax simulation, owner powers, liquidity and price impact, deployer reputation.
On NEAR: who controls the token (full-access keys, owner, pause) and whether you can exit, tested as a USDC round trip through NEAR Intents.
Call this before any swap into a token you do not already trust. Do not buy on STOP.`,
    schema: PreTradeSchema,
  })
  async preTradeCheck(wallet: EvmWalletProvider, args: z.infer<typeof PreTradeSchema>): Promise<string> {
    try {
      const c = this.client(wallet);
      const r =
        args.chain === "near"
          ? await c.call("near-pre-trade-gate", { token: args.token, size: args.sizeUsd })
          : await c.call("pre-trade-gate", { address: args.token, amountUsd: args.sizeUsd });
      return JSON.stringify(r);
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }

  @CreateAction({
    name: "swap_on_base",
    description: `Swap tokens on Base at the best price across Base DEXes (Uniswap, Aerodrome, Balancer, Curve… routed by 0x) and EXECUTE it from this wallet.
Approves exactly the amount sold if needed, then sends the swap and waits for it. Returns the route, amounts and transaction hash.
Buying an unknown token runs a sellability check first and refuses a honeypot. The swap reverts (costing only gas) if the price moves beyond slippage.`,
    schema: BaseSwapSchema,
  })
  async swapOnBase(wallet: EvmWalletProvider, args: z.infer<typeof BaseSwapSchema>): Promise<string> {
    try {
      if (wallet.getNetwork().chainId !== "8453") return "Error: swap_on_base needs the wallet on Base mainnet (chainId 8453).";
      const c = this.client(wallet);
      const taker = wallet.getAddress();
      const quote = () =>
        c.call<BaseSwapQuote>("base-swap", { sell: args.sell, buy: args.buy, amount: args.amount, taker, slippage: args.slippageBps });
      let q = await quote();
      if (q.insufficientBalance) return `Error: this wallet does not hold ${q.sell.amount} ${q.sell.symbol}.`;
      let approval: string | null = null;
      if (q.needsApproval) {
        approval = await wallet.sendTransaction({
          to: q.needsApproval.token as `0x${string}`,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [q.needsApproval.spender as `0x${string}`, BigInt(q.sell.amountBaseUnits)],
          }),
        });
        await wallet.waitForTransactionReceipt(approval as `0x${string}`);
        q = await quote(); // quotes are short-lived; take a fresh one after the approval
      }
      const hash = await wallet.sendTransaction({
        to: q.transaction.to as `0x${string}`,
        data: q.transaction.data as `0x${string}`,
        value: BigInt(q.transaction.value || "0"),
      });
      const receipt = (await wallet.waitForTransactionReceipt(hash)) as { status?: string };
      if (receipt?.status && receipt.status !== "success") return `Swap reverted (price moved beyond slippage). Tx: ${hash}`;
      return JSON.stringify({
        swapped: `${q.sell.amount} ${q.sell.symbol} → ~${q.buy.amount} ${q.buy.symbol} (min ${q.buy.minAmount})`,
        route: q.route,
        fees: q.fees,
        approvalTx: approval,
        tx: hash,
        explorer: `https://basescan.org/tx/${hash}`,
      });
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }

  @CreateAction({
    name: "cross_chain_swap",
    description: `Swap across chains through NEAR Intents — NEAR, Base, Ethereum, Solana, Bitcoin and more — e.g. USDC@base → NEAR, ETH@base → SOL@sol.
Returns a one-time deposit address. When paying FROM Base, this action also sends the deposit from this wallet; otherwise it returns what to send, where, and by when.
The output goes to recipient, or the deposit is refunded to refundTo. Buying a NEAR token runs a token-safety check first. Track with cross_chain_swap_status.`,
    schema: CrossChainSchema,
  })
  async crossChainSwap(wallet: EvmWalletProvider, args: z.infer<typeof CrossChainSchema>): Promise<string> {
    try {
      const c = this.client(wallet);
      const fromBase = /@base$/i.test(args.from);
      const refundTo = args.refundTo || (fromBase ? wallet.getAddress() : "");
      if (!refundTo) return "Error: refundTo is required when not paying from Base (your address on the origin chain).";
      const q = await c.call<NearSwapQuote>("near-swap", { from: args.from, to: args.to, amount: args.amount, recipient: args.recipient, refundTo });
      const origin = q.deposit.chain === "base" ? baseOriginToken(q.from.assetId) : null;
      if (!origin || wallet.getNetwork().chainId !== "8453") {
        return JSON.stringify({ sendThis: q.deposit, youGet: `~${q.amountOut} ${q.to.symbol} (min ${q.minAmountOut})`, next: q.next });
      }
      const amount = BigInt(q.deposit.amountBaseUnits);
      const hash = origin.native
        ? await wallet.sendTransaction({ to: q.deposit.address as `0x${string}`, value: amount })
        : await wallet.sendTransaction({
            to: origin.address,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [q.deposit.address as `0x${string}`, amount] }),
          });
      await wallet.waitForTransactionReceipt(hash);
      return JSON.stringify({
        deposited: `${q.deposit.amount} ${q.deposit.asset} on Base → ${q.deposit.address}`,
        depositTx: `https://basescan.org/tx/${hash}`,
        youGet: `~${q.amountOut} ${q.to.symbol} (min ${q.minAmountOut}) at ${args.recipient}`,
        track: `cross_chain_swap_status with depositAddress ${q.deposit.address}`,
      });
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }

  @CreateAction({
    name: "cross_chain_swap_status",
    description: "Where is a cross-chain swap? Pending deposit, processing, SUCCESS, REFUNDED or FAILED, with amounts and transactions.",
    schema: StatusSchema,
  })
  async crossChainSwapStatus(wallet: EvmWalletProvider, args: z.infer<typeof StatusSchema>): Promise<string> {
    try {
      return JSON.stringify(await this.client(wallet).call("near-swap-status", { depositAddress: args.depositAddress }));
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }

  @CreateAction({
    name: "x402_bazaar_call",
    description: `Call any x402 Bazaar service by id — 150+ pay-per-call APIs for agents: token risk, wallet and approval audits, NEAR account/portfolio/staking yields/lending health, web search and page-to-JSON, OFAC screening and more.
List them at https://402.com.tr/api/catalog. Pass the service's query parameters in params.`,
    schema: CallSchema,
  })
  async call(wallet: EvmWalletProvider, args: z.infer<typeof CallSchema>): Promise<string> {
    try {
      return JSON.stringify(await this.client(wallet).call(args.service, args.params));
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }

  supportsNetwork = (network: Network) => network.protocolFamily === "evm";
}

export const x402BazaarActionProvider = (options?: X402BazaarOptions) => new X402BazaarActionProvider(options);
