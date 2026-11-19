/**
 * LCX Liberty DEX — a second quote source for base-swap, beside 0x. Off unless
 * LCX_API_KEY is set (key at dex.lcx.com/dashboard); base-swap decides when it
 * is asked (BASE_SWAP_PROVIDER, BASE_SWAP_COMPARE).
 *
 * One POST /v1/swap returns the quote and the transaction for the taker, and
 * GET /v1/allowance names the contract to approve. The answer is mapped into
 * the 0x quote shape, so base-swap builds its response along one path.
 *
 * Nothing is handed out unchecked: the transaction must go to the spender
 * /v1/allowance named, on Base, and its calldata must decode to a sale of
 * exactly this amount of these tokens, to the taker, with a floor no lower than
 * the quote's and a live deadline. Any mismatch throws, and base-swap serves 0x.
 *
 * Integrator fee: LCX does not take a rate per request. LCX registers a rate
 * on-chain for an integrator address (at most 100 bps). When base-swap's fee is
 * on, its recipient goes in as `integrator`; what was charged is read from the
 * quote's `fee` block (`output.amount` is net of it), and a rate above
 * BASE_SWAP_FEE_BPS, or a fee to anyone else, is refused.
 * TODO: until LCX has registered the fee recipient, that block reads 0 bps and
 * an LCX-served swap earns no fee.
 */

import "server-only";
import { createPublicClient, decodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import type { ZeroExQuote } from "./base-swap";

const API = "https://swap-api.lcx.com/v1";
const EEEE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";
/** Bebop's settlement contracts: the only ones a makerSwap leg may call. */
const BEBOP = new Set(["0xbeb0009aca35087ce7ccf11637e24dd1aad3bf2a", "0xbbbbbbb520d69a9775e85b458c58c648259fad5f"]);

const eq = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
/** A base-units amount: base-swap turns these into BigInt, so anything else is refused here. */
const int = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
/** LCX names native ETH by the zero address; base-swap by 0xEeee…. */
const toLcx = (t: string) => (eq(t, EEEE) ? ZERO : t);
const fromLcx = (t: string) => (eq(t, ZERO) ? EEEE : t);

const LEGS = { name: "legs", type: "tuple[]", components: [
  { name: "amountIn", type: "uint256" },
  { name: "hops", type: "tuple[]", components: [
    { name: "family", type: "uint8" }, { name: "pool", type: "address" },
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "aux", type: "uint256" } ] } ] } as const;
const FEE_SWAP_ARGS = { name: "a", type: "tuple", components: [
  { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
  { name: "totalIn", type: "uint256" }, { name: "minAmountOut", type: "uint256" },
  { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" },
  { name: "integrator", type: "address" } ] } as const;
/** The LCX router's five swap entrypoints (the same address on Base, Ethereum, Arbitrum and OP Mainnet). */
export const LCX_ROUTER_ABI = [
  { name: "swapSplit", type: "function", stateMutability: "payable", inputs: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "totalIn", type: "uint256" }, { name: "minAmountOut", type: "uint256" },
    { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" }, LEGS ],
    outputs: [{ name: "amountOut", type: "uint256" }] },
  { name: "swapSplitWithFee", type: "function", stateMutability: "payable",
    inputs: [FEE_SWAP_ARGS, LEGS], outputs: [{ name: "amountOut", type: "uint256" }] },
  { name: "swapSplitViaPropAMM", type: "function", stateMutability: "payable",
    inputs: [FEE_SWAP_ARGS, LEGS, { name: "venue", type: "address" }, { name: "coreNetOut", type: "uint256" }],
    outputs: [{ name: "amountOut", type: "uint256" }] },
  { name: "swapSplitWithPropAMMSplit", type: "function", stateMutability: "payable",
    inputs: [FEE_SWAP_ARGS, { ...LEGS, name: "splitLegs" }, { ...LEGS, name: "fullLegs" },
      { name: "s", type: "tuple", components: [
        { name: "venue", type: "address" }, { name: "venueIn", type: "uint256" }, { name: "venueMinOut", type: "uint256" } ] }],
    outputs: [{ name: "amountOut", type: "uint256" }] },
  { name: "makerSwap", type: "function", stateMutability: "payable", inputs: [
    { name: "a", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" }, { name: "minAmountOut", type: "uint256" },
      { name: "recipient", type: "address" }, { name: "deadline", type: "uint256" } ] },
    { ...LEGS, name: "poolLegs" },
    { name: "m", type: "tuple", components: [
      { name: "target", type: "address" }, { name: "spender", type: "address" },
      { name: "amountIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "data", type: "bytes" } ] },
    { ...LEGS, name: "fallbackLegs" } ],
    outputs: [{ name: "amountOut", type: "uint256" }] },
] as const;

/** What the calldata must do. Tokens as LCX names them (native = zero address). */
interface Want {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  recipient: string;
  minOut: bigint;
  integrator: string | null;
}

/**
 * Why this calldata must not be signed, or null when it does what was asked —
 * the checks LCX Liberty DEX's own app runs before it signs, for one swap.
 */
export function lcxCalldataProblem(data: string, want: Want): string | null {
  let d;
  try {
    d = decodeFunctionData({ abi: LCX_ROUTER_ABI, data: data as Hex });
  } catch {
    return "calldata is not an LCX router swap";
  }
  let s: { tokenIn: string; tokenOut: string; totalIn: bigint; minAmountOut: bigint; recipient: string; deadline: bigint; integrator: string };
  if (d.functionName === "swapSplit") {
    const [tokenIn, tokenOut, totalIn, minAmountOut, recipient, deadline] = d.args;
    s = { tokenIn, tokenOut, totalIn, minAmountOut, recipient, deadline, integrator: ZERO };
  } else if (d.functionName === "makerSwap") {
    const [a, , m] = d.args;
    const bebop = BEBOP.has(m.target.toLowerCase()) && BEBOP.has(m.spender.toLowerCase());
    const empty = m.amountIn === 0n && eq(m.target, ZERO) && eq(m.spender, ZERO) && m.data === "0x";
    if (!bebop && !empty) return "maker leg calls a contract other than Bebop";
    if (m.amountIn > a.amountIn) return "maker leg spends more than the input";
    s = { ...a, totalIn: a.amountIn, integrator: ZERO };
  } else {
    s = d.args[0];
    if (d.functionName === "swapSplitWithPropAMMSplit" && d.args[3].venueIn > s.totalIn) return "prop-AMM leg spends more than the input";
  }
  if (!eq(s.recipient, want.recipient)) return "recipient is not the taker";
  if (s.totalIn !== want.amountIn) return "sells a different amount";
  if (!eq(s.tokenIn, want.tokenIn) || !eq(s.tokenOut, want.tokenOut)) return "swaps different tokens";
  if (s.minAmountOut < want.minOut) return "minimum out is below the quoted floor";
  if (s.deadline <= BigInt(Math.floor(Date.now() / 1000))) return "deadline has passed";
  if (!eq(s.integrator, ZERO) && !eq(s.integrator, want.integrator)) return "a fee goes to an integrator we did not name";
  return null;
}

interface LcxSwap {
  success?: boolean;
  code?: string;
  data?: {
    quote?: {
      chainId?: number;
      input?: { amount: string; token: string };
      output?: { amount: string; minimumAmount: string; token: string };
      spender?: string | null;
      gasEstimateWei?: string | null;
      fee?: { bps: number; amount: string; token: string; integrator: string };
      routes?: { amountIn: string; hops: { dex: string }[] }[];
    };
    transaction?: { to?: string; data?: string; value?: string; gas?: string | null; chainId?: number; routerDeployed?: boolean; minAmountOut?: string };
  };
}

interface LcxAllowance {
  success?: boolean;
  data?: { required: boolean; allowance: string | null; spender: string | null };
}

/** The taker's balance of what it sells; null when the read fails (unknown, as with 0x). */
async function balanceOf(token: string, owner: string): Promise<bigint | null> {
  const client = createPublicClient({ chain: base, transport: baseTransport(8000) });
  const read =
    token === ZERO
      ? client.getBalance({ address: owner as Address })
      : client.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [owner as Address] });
  return read.catch(() => null);
}

/**
 * A Base quote and transaction from LCX Liberty DEX, in 0x's quote shape, plus
 * `feeBps`: the integrator fee LCX actually applied. Throws on any failure
 * (no_route, insufficient_liquidity, HTTP or network errors, a failed check).
 */
export async function lcxBaseQuote(p: {
  key: string;
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  taker: string;
  slippageBps: number;
  /** BASE_SWAP_FEE_RECIPIENT when the fee is on: LCX looks up the rate it registered for it. */
  integrator: string | null;
  /** BASE_SWAP_FEE_BPS: LCX may not charge more than this. */
  maxFeeBps: number;
}): Promise<ZeroExQuote & { feeBps: number }> {
  const tokenIn = toLcx(p.sellToken);
  const tokenOut = toLcx(p.buyToken);
  const amountIn = p.sellAmount.toString();
  const auth = { authorization: `Bearer ${p.key}`, accept: "application/json" };
  const signal = AbortSignal.timeout(10_000);
  const [swapRes, allowRes, held] = await Promise.all([
    fetch(`${API}/swap`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ chainId: 8453, tokenIn, tokenOut, amountIn, taker: p.taker, slippageBps: p.slippageBps, ...(p.integrator ? { integrator: p.integrator } : {}) }),
      signal,
    }),
    fetch(`${API}/allowance?${new URLSearchParams({ chainId: "8453", token: tokenIn, taker: p.taker, amount: amountIn })}`, { headers: auth, signal }),
    balanceOf(tokenIn, p.taker),
  ]);
  const r = (await swapRes.json().catch(() => ({}))) as LcxSwap;
  if (!swapRes.ok || r.success !== true) throw new Error(`LCX Liberty DEX: ${r.code || swapRes.status}`);
  const a = (await allowRes.json().catch(() => ({}))) as LcxAllowance;
  if (!allowRes.ok || a.success !== true || !a.data?.spender) throw new Error(`LCX Liberty DEX allowance: ${allowRes.status}`);
  const spender = a.data.spender;
  const q = r.data?.quote;
  const tx = r.data?.transaction;

  function refuse(why: string): never {
    console.error(`[base-swap] LCX Liberty DEX transaction refused: ${why}`);
    throw new Error(`LCX Liberty DEX transaction refused: ${why}`);
  }
  if (!q?.input || !int(q.output?.amount) || !int(q.output.minimumAmount) || !tx?.to || !tx.data || tx.routerDeployed !== true) refuse("no transaction");
  if (q.chainId !== 8453 || tx.chainId !== 8453) refuse("not a Base transaction");
  if (!eq(tx.to, spender) || !eq(q.spender, spender)) refuse("transaction does not go to the router /v1/allowance named");
  if (q.input.amount !== amountIn || !eq(q.input.token, tokenIn) || !eq(q.output.token, tokenOut)) refuse("quote is for a different trade");
  if (!int(tx.minAmountOut) || BigInt(tx.minAmountOut) < BigInt(q.output.minimumAmount)) refuse("no minimum out at the quoted floor");
  if (BigInt(tx.value ?? "0") !== (tokenIn === ZERO ? p.sellAmount : 0n)) refuse("transaction value does not match the sale");
  const fee = q.fee;
  const feeBps = fee?.bps ?? 0;
  if (fee && feeBps > 0 && (feeBps > p.maxFeeBps || !eq(fee.integrator, p.integrator) || !int(fee.amount))) refuse(`a ${feeBps} bps fee we did not configure`);
  const calldata = lcxCalldataProblem(tx.data, { tokenIn, tokenOut, amountIn: p.sellAmount, recipient: p.taker, minOut: BigInt(tx.minAmountOut), integrator: p.integrator });
  if (calldata) refuse(calldata);

  return {
    liquidityAvailable: true,
    buyAmount: q.output.amount,
    minBuyAmount: tx.minAmountOut,
    sellAmount: amountIn,
    transaction: { to: tx.to, data: tx.data, value: tx.value ?? "0", ...(tx.gas ? { gas: tx.gas } : {}) },
    issues: {
      allowance: a.data.required ? { actual: a.data.allowance ?? "0", spender } : null,
      balance: held !== null && held < p.sellAmount ? { token: p.sellToken, actual: held.toString(), expected: amountIn } : null,
    },
    fees: { integratorFee: fee && feeBps > 0 ? { amount: fee.amount, token: fromLcx(fee.token) } : null, zeroExFee: null },
    route: { fills: (q.routes ?? []).map((l) => ({ source: l.hops.map((h) => h.dex).join(" > "), proportionBps: String((BigInt(l.amountIn) * 10_000n) / p.sellAmount) })) },
    totalNetworkFee: int(q.gasEstimateWei) ? q.gasEstimateWei : undefined,
    feeBps,
  };
}
