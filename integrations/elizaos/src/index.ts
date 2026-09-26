/**
 * x402 Bazaar plugin for ElizaOS — check, then act.
 *
 *   import { x402BazaarPlugin } from "x402-bazaar-eliza";
 *   character.plugins = [..., x402BazaarPlugin];
 *
 * Settings (character secrets or env):
 *   X402_CREDIT_TOKEN   prepaid credit token (ck_…) — pays calls with one header, no signing
 *   EVM_PRIVATE_KEY     a Base wallet key — pays per call over x402 when there is no
 *                       credit token, and signs the swaps this plugin executes
 *   X402_BAZAAR_URL     optional, defaults to https://402.com.tr
 *
 * Swaps are sent by the agent's own wallet (Base) or deposited by it to NEAR
 * Intents (cross-chain); nothing is held by x402 Bazaar.
 */

import { ModelType, parseJSONObjectFromText, type Action, type IAgentRuntime, type Memory, type Plugin, type State } from "@elizaos/core";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { BazaarClient, baseOriginToken, type BaseSwapQuote, type NearSwapQuote } from "./client.js";

export { BazaarClient } from "./client.js";

function setting(runtime: IAgentRuntime, key: string): string {
  const v = runtime.getSetting(key);
  return typeof v === "string" ? v.trim() : "";
}

function wallet(runtime: IAgentRuntime) {
  const raw = setting(runtime, "EVM_PRIVATE_KEY");
  if (!raw) return null;
  const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
  return {
    account,
    wallet: createWalletClient({ account, chain: base, transport: http() }),
    reader: createPublicClient({ chain: base, transport: http() }),
  };
}

function client(runtime: IAgentRuntime): BazaarClient {
  const w = wallet(runtime);
  return new BazaarClient({
    baseUrl: setting(runtime, "X402_BAZAAR_URL") || undefined,
    creditToken: setting(runtime, "X402_CREDIT_TOKEN") || undefined,
    signer: w ? { address: w.account.address, signTypedData: (td) => w.account.signTypedData(td as never) } : undefined,
  });
}

/**
 * The action's inputs: from the planner when the runtime passes them (ElizaOS 2.x
 * `options.parameters`), else extracted from the conversation by the agent's model.
 */
async function inputs(runtime: IAgentRuntime, message: Memory, state: State | undefined, options: unknown, shape: string): Promise<Record<string, string>> {
  const given = (options as { parameters?: Record<string, unknown> } | undefined)?.parameters;
  if (given && Object.keys(given).length) return Object.fromEntries(Object.entries(given).map(([k, v]) => [k, String(v)]));
  const recent = (state?.text as string | undefined) ?? "";
  const prompt = `Extract the parameters for this request as a JSON object with exactly these keys:
${shape}
Use "" for anything the user did not say. Return only the JSON.

Recent conversation:
${recent.slice(-3000)}

Request: ${message.content.text ?? ""}`;
  const out = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
  const parsed = parseJSONObjectFromText(String(out)) ?? {};
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)]));
}

const always = async () => true;

const preTradeCheck: Action = {
  name: "PRE_TRADE_CHECK",
  similes: ["CHECK_TOKEN", "TOKEN_SAFETY", "IS_TOKEN_SAFE", "RUG_CHECK", "HONEYPOT_CHECK"],
  description:
    "Check a token BEFORE buying it: GO / HOLD / STOP with reasons. Base: honeypot and sell-tax simulation, owner powers, liquidity, deployer. NEAR: who controls the token (keys, owner, pause) and whether you can exit through NEAR Intents. Do not buy on STOP.",
  validate: always,
  handler: async (runtime, message, state, options, callback) => {
    try {
      const p = await inputs(runtime, message, state, options, `"chain": "base" or "near", "token": 0x… address on Base or NEAR token account, "sizeUsd": trade size in USD or ""`);
      const near = p.chain === "near" || (!/^0x[0-9a-fA-F]{40}$/.test(p.token) && /\.(near|tg)$|^[0-9a-f]{64}$/.test(p.token));
      const r = near
        ? await client(runtime).call<{ verdict: string; reasons: string[] }>("near-pre-trade-gate", { token: p.token, size: p.sizeUsd })
        : await client(runtime).call<{ verdict?: string; decision?: string; reasons?: string[] }>("pre-trade-gate", { address: p.token, amountUsd: p.sizeUsd });
      const verdict = (r as { verdict?: string; decision?: string }).verdict ?? (r as { decision?: string }).decision ?? "?";
      const text = `${verdict} for ${p.token}${Array.isArray(r.reasons) && r.reasons.length ? ` — ${r.reasons.slice(0, 3).join(" ")}` : ""}`;
      await callback?.({ text, actions: ["PRE_TRADE_CHECK"] });
      return { success: true, text, data: r as Record<string, unknown> };
    } catch (e) {
      await callback?.({ text: `Token check failed: ${(e as Error).message}` });
      return { success: false, text: (e as Error).message };
    }
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "Is 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed safe to buy on Base?" } },
      { name: "{{agent}}", content: { text: "Checking it before any trade.", actions: ["PRE_TRADE_CHECK"] } },
    ],
  ],
};

const swapOnBase: Action = {
  name: "SWAP_ON_BASE",
  similes: ["BASE_SWAP", "SWAP_TOKENS_BASE", "BUY_ON_BASE", "SELL_ON_BASE"],
  description:
    "Swap tokens on Base at the best price across Base DEXes (routed by 0x) and execute it from the agent's wallet (EVM_PRIVATE_KEY). Approves exactly the amount sold if needed. Unknown tokens get a sellability check first; honeypots are refused.",
  validate: async (runtime) => Boolean(setting(runtime, "EVM_PRIVATE_KEY")),
  handler: async (runtime, message, state, options, callback) => {
    try {
      const w = wallet(runtime);
      if (!w) throw new Error("EVM_PRIVATE_KEY is not set");
      const p = await inputs(runtime, message, state, options, `"sell": token symbol or 0x address, "buy": token symbol or 0x address, "amount": amount to sell in whole units`);
      const c = client(runtime);
      const quote = () => c.call<BaseSwapQuote>("base-swap", { sell: p.sell, buy: p.buy, amount: p.amount, taker: w.account.address });
      let q = await quote();
      if (q.insufficientBalance) throw new Error(`the wallet does not hold ${q.sell.amount} ${q.sell.symbol}`);
      if (q.needsApproval) {
        const approval = await w.wallet.sendTransaction({
          to: q.needsApproval.token as Hex,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [q.needsApproval.spender as Hex, BigInt(q.sell.amountBaseUnits)] }),
        });
        await w.reader.waitForTransactionReceipt({ hash: approval });
        q = await quote();
      }
      const hash = await w.wallet.sendTransaction({
        to: q.transaction.to as Hex,
        data: q.transaction.data as Hex,
        value: BigInt(q.transaction.value || "0"),
      });
      const rc = await w.reader.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`the swap reverted (price moved beyond slippage): ${hash}`);
      const text = `Swapped ${q.sell.amount} ${q.sell.symbol} → ~${q.buy.amount} ${q.buy.symbol} via ${q.route.map((r) => `${r.source} ${r.sharePct}%`).join(", ")}. https://basescan.org/tx/${hash}`;
      await callback?.({ text, actions: ["SWAP_ON_BASE"] });
      return { success: true, text, data: { tx: hash, route: q.route, fees: q.fees } };
    } catch (e) {
      await callback?.({ text: `Swap failed: ${(e as Error).message}` });
      return { success: false, text: (e as Error).message };
    }
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "Swap 25 USDC to ETH on Base" } },
      { name: "{{agent}}", content: { text: "Routing 25 USDC to ETH at the best Base price.", actions: ["SWAP_ON_BASE"] } },
    ],
  ],
};

const crossChainSwap: Action = {
  name: "CROSS_CHAIN_SWAP",
  similes: ["BRIDGE_AND_SWAP", "SWAP_TO_NEAR", "SWAP_ACROSS_CHAINS", "NEAR_INTENTS_SWAP"],
  description:
    "Swap across chains through NEAR Intents (NEAR, Base, Ethereum, Solana, Bitcoin…), e.g. USDC@base → NEAR. Returns a one-time deposit address; when paying from Base with EVM_PRIVATE_KEY set, the agent's wallet sends the deposit itself. Output goes to the recipient; failed swaps are refunded.",
  validate: always,
  handler: async (runtime, message, state, options, callback) => {
    try {
      const p = await inputs(
        runtime,
        message,
        state,
        options,
        `"from": asset paid (USDC, NEAR, USDC@base, ETH@base, SOL@sol…), "to": asset wanted, "amount": amount of the paid asset, "recipient": address on the destination chain, "refundTo": address on the origin chain or ""`,
      );
      const w = wallet(runtime);
      const refundTo = p.refundTo || (/@base$/i.test(p.from) && w ? w.account.address : "");
      if (!refundTo) throw new Error("say where a refund should go (your address on the chain you pay from)");
      const q = await client(runtime).call<NearSwapQuote>("near-swap", { from: p.from, to: p.to, amount: p.amount, recipient: p.recipient, refundTo });
      const origin = q.deposit.chain === "base" ? baseOriginToken(q.from.assetId) : null;
      if (!origin || !w) {
        const text = `Send exactly ${q.deposit.amount} ${q.deposit.asset} on ${q.deposit.chain} to ${q.deposit.address}${q.deposit.memo ? ` (memo ${q.deposit.memo})` : ""} before ${q.deposit.sendBefore}. You get ~${q.amountOut} ${q.to.symbol}.`;
        await callback?.({ text, actions: ["CROSS_CHAIN_SWAP"] });
        return { success: true, text, data: q as unknown as Record<string, unknown> };
      }
      const amount = BigInt(q.deposit.amountBaseUnits);
      const hash = origin.native
        ? await w.wallet.sendTransaction({ to: q.deposit.address as Hex, value: amount })
        : await w.wallet.sendTransaction({
            to: origin.address,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [q.deposit.address as Hex, amount] }),
          });
      await w.reader.waitForTransactionReceipt({ hash });
      const text = `Deposited ${q.deposit.amount} ${q.deposit.asset} on Base (https://basescan.org/tx/${hash}); ~${q.amountOut} ${q.to.symbol} is on its way to ${p.recipient}. Track: deposit address ${q.deposit.address}.`;
      await callback?.({ text, actions: ["CROSS_CHAIN_SWAP"] });
      return { success: true, text, data: { depositTx: hash, depositAddress: q.deposit.address } };
    } catch (e) {
      await callback?.({ text: `Cross-chain swap failed: ${(e as Error).message}` });
      return { success: false, text: (e as Error).message };
    }
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "Swap 10 USDC on Base to NEAR, send it to alice.near" } },
      { name: "{{agent}}", content: { text: "Starting the cross-chain swap through NEAR Intents.", actions: ["CROSS_CHAIN_SWAP"] } },
    ],
  ],
};

const swapStatus: Action = {
  name: "CROSS_CHAIN_SWAP_STATUS",
  similes: ["SWAP_STATUS", "CHECK_SWAP"],
  description: "Where is a cross-chain swap? Give the deposit address; answers pending, processing, SUCCESS, REFUNDED or FAILED.",
  validate: always,
  handler: async (runtime, message, state, options, callback) => {
    try {
      const p = await inputs(runtime, message, state, options, `"depositAddress": the swap's deposit address`);
      const r = await client(runtime).call<{ status: string; meaning?: string }>("near-swap-status", { depositAddress: p.depositAddress });
      const text = `${r.status}${r.meaning ? ` — ${r.meaning}` : ""}`;
      await callback?.({ text, actions: ["CROSS_CHAIN_SWAP_STATUS"] });
      return { success: true, text, data: r as Record<string, unknown> };
    } catch (e) {
      await callback?.({ text: `Status check failed: ${(e as Error).message}` });
      return { success: false, text: (e as Error).message };
    }
  },
  examples: [],
};

const callService: Action = {
  name: "X402_BAZAAR_CALL",
  similes: ["CALL_BAZAAR", "X402_SERVICE"],
  description:
    "Call any x402 Bazaar service by id (catalog: https://402.com.tr/api/catalog) — token risk, wallet and approval audits, NEAR account/portfolio/staking yields/lending health, web search and page-to-JSON, OFAC screening and more.",
  validate: always,
  handler: async (runtime, message, state, options, callback) => {
    try {
      const p = await inputs(runtime, message, state, options, `"service": service id such as token-risk or near-portfolio, "params": the service's query parameters as a JSON-encoded object string`);
      let params: Record<string, string> = {};
      try {
        params = JSON.parse(p.params || "{}");
      } catch {
        /* model gave no usable params */
      }
      const r = await client(runtime).call(p.service, params);
      const text = JSON.stringify(r).slice(0, 1500);
      await callback?.({ text, actions: ["X402_BAZAAR_CALL"] });
      return { success: true, text, data: r as Record<string, unknown> };
    } catch (e) {
      await callback?.({ text: `Call failed: ${(e as Error).message}` });
      return { success: false, text: (e as Error).message };
    }
  },
  examples: [],
};

export const x402BazaarPlugin: Plugin = {
  name: "x402-bazaar",
  description: "Check, then act: pre-trade GO/HOLD/STOP on Base and NEAR, best-price swaps on Base, cross-chain swaps via NEAR Intents, and 150+ pay-per-call agent APIs.",
  actions: [preTradeCheck, swapOnBase, crossChainSwap, swapStatus, callService],
};

export default x402BazaarPlugin;
