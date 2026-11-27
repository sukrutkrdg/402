/**
 * Base swap — an executable swap on Base, routed by the 0x Swap API across the
 * DEXes there (Uniswap, Aerodrome, Balancer, Curve and more) for the best price.
 *
 * Returns a ready-to-sign transaction for the agent's own wallet (`taker`). We
 * never hold funds or keys: the agent approves 0x's AllowanceHolder contract if
 * asked, then sends the transaction itself.
 *
 * Integrator fee: when BASE_SWAP_FEE_BPS is set, 0x takes that share of the
 * trade inside the same transaction and delivers it to BASE_SWAP_FEE_RECIPIENT
 * (default PAY_TO_ADDRESS) — no withdrawal step, no split. Off when unset.
 *
 * LCX Liberty DEX (optional, LCX_API_KEY — key at dex.lcx.com/dashboard) is a
 * second quote source beside 0x, in base-swap-lcx.ts. BASE_SWAP_PROVIDER=lcx
 * serves it and falls back to 0x on any failure; =best asks both at once and
 * serves the larger output net of each one's fee; BASE_SWAP_COMPARE=1 asks both
 * and logs both while the chosen provider keeps serving. Unset: 0x only. LCX
 * charges the fee rate it registered for the fee recipient, read from its quote.
 *
 * Buying a token that is not a major: run through sellability first (honeypot,
 * sell tax); a token that cannot be sold is refused (not charged) unless force=1.
 *
 * Needs ZEROX_API_KEY (free at dashboard.0x.org).
 */

import "server-only";
import { createPublicClient, erc20Abi, formatUnits, parseUnits, getAddress, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { sellability } from "./sellability";
import { lcxBaseQuote, FEE_CONTRACT } from "./base-swap-lcx";

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** Majors: named by symbol, skip the sellability check. */
export const BASE_MAJORS: Record<string, { address: string; decimals: number }> = {
  ETH: { address: NATIVE, decimals: 18 },
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  USDBC: { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6 },
  DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
  EURC: { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6 },
  CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  CBETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  AERO: { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18 },
};
const MAJOR_ADDRS = new Set(Object.values(BASE_MAJORS).map((m) => m.address.toLowerCase()));

/** The integrator fee, or null when off. Capped at 1%. */
export function baseSwapFee(): { recipient: string; bps: number } | null {
  const bps = Number(process.env.BASE_SWAP_FEE_BPS || 0);
  const recipient = (process.env.BASE_SWAP_FEE_RECIPIENT || process.env.PAY_TO_ADDRESS || "").trim();
  if (!Number.isInteger(bps) || bps <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) return null;
  return { recipient, bps: Math.min(bps, 100) };
}

/** Who serves the swap: 0x (the default), lcx or best. Anything but 0x needs LCX_API_KEY. */
export function baseSwapProvider(): "0x" | "lcx" | "best" {
  const p = (process.env.BASE_SWAP_PROVIDER || "").trim().toLowerCase();
  return process.env.LCX_API_KEY && (p === "lcx" || p === "best") ? p : "0x";
}

async function resolve(raw: string, what: string): Promise<{ address: string; symbol: string; decimals: number; major: boolean }> {
  const q = (raw || "").trim();
  if (!q) throw new Error(`${what} is required: a symbol (ETH, USDC, WETH, cbBTC, AERO…) or a Base token address`);
  const m = BASE_MAJORS[q.toUpperCase()];
  if (m) return { address: m.address, symbol: q.toUpperCase() === "USDBC" ? "USDbC" : q.toUpperCase(), decimals: m.decimals, major: true };
  if (!/^0x[0-9a-fA-F]{40}$/.test(q)) throw new Error(`${what}: ${q} is not a known symbol or a 0x… token address`);
  const address = getAddress(q);
  const known = Object.entries(BASE_MAJORS).find(([, v]) => v.address.toLowerCase() === address.toLowerCase());
  if (known) return { address, symbol: known[0], decimals: known[1].decimals, major: true };
  const client = createPublicClient({ chain: base, transport: baseTransport(8000) });
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: address as Address, abi: erc20Abi, functionName: "decimals" }).catch(() => null),
    client.readContract({ address: address as Address, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
  ]);
  if (decimals === null) throw new Error(`${what}: ${address} is not an ERC-20 on Base (no decimals())`);
  return { address, symbol: symbol ?? address.slice(0, 8), decimals: Number(decimals), major: MAJOR_ADDRS.has(address.toLowerCase()) };
}

export interface ZeroExQuote {
  liquidityAvailable?: boolean;
  buyAmount?: string;
  minBuyAmount?: string;
  sellAmount?: string;
  transaction?: { to: string; data: string; value?: string; gas?: string; gasPrice?: string };
  issues?: {
    allowance?: { actual: string; spender: string } | null;
    balance?: { token: string; actual: string; expected: string } | null;
    simulationIncomplete?: boolean;
  };
  fees?: { integratorFee?: { amount: string; token: string } | null; zeroExFee?: { amount: string; token: string } | null };
  route?: { fills?: { source: string; proportionBps: string }[] };
  totalNetworkFee?: string;
  message?: string;
  name?: string;
}

export async function baseSwap(params: Record<string, string>) {
  const key = process.env.ZEROX_API_KEY;
  if (!key) throw new Error("Base swaps are not configured on this server (ZEROX_API_KEY) — not charged");
  const taker = (params.taker || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(taker)) throw new Error("taker is required: the 0x… wallet that will sign and send the swap");
  const slippage = params.slippage ? Number(params.slippage) : 100;
  if (!Number.isInteger(slippage) || slippage < 1 || slippage > 1000) throw new Error("slippage is in basis points: 1–1000 (default 100 = 1%)");

  const [sell, buy] = await Promise.all([resolve(params.sell || params.from, "sell"), resolve(params.buy || params.to, "buy")]);
  if (sell.address.toLowerCase() === buy.address.toLowerCase()) throw new Error("sell and buy are the same token");
  let sellAmount: bigint;
  try {
    sellAmount = parseUnits((params.amount || "").trim(), sell.decimals);
  } catch {
    throw new Error(`amount must be a positive number of ${sell.symbol}, e.g. 100`);
  }
  if (sellAmount <= 0n) throw new Error(`amount must be a positive number of ${sell.symbol}, e.g. 100`);

  // Buying something that is not a major: can it be sold again?
  let safety: { canSell: boolean | null; riskLevel: string; reasons: unknown } | null = null;
  if (!buy.major) {
    const s = (await sellability({ address: buy.address })) as { canSell?: boolean | null; riskLevel?: string; reasons?: unknown };
    safety = { canSell: s.canSell ?? null, riskLevel: s.riskLevel ?? "unknown", reasons: s.reasons ?? [] };
    if (s.canSell === false && params.force !== "1") {
      throw new Error(`Refused: ${buy.symbol} (${buy.address}) cannot be sold again (honeypot or blocked sell) — not charged. Pass force=1 to quote anyway.`);
    }
  }

  const fee = baseSwapFee();
  const feeToken = sell.address !== NATIVE ? sell.address : buy.address;
  const qs = new URLSearchParams({
    chainId: "8453",
    sellToken: sell.address,
    buyToken: buy.address,
    sellAmount: sellAmount.toString(),
    taker,
    slippageBps: String(slippage),
    ...(fee ? { swapFeeRecipient: fee.recipient, swapFeeBps: String(fee.bps), swapFeeToken: feeToken } : {}),
  });
  const quote0x = async (): Promise<ZeroExQuote> => {
    let res: Response;
    try {
      res = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${qs}`, {
        headers: { "0x-api-key": key, "0x-version": "v2", accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("0x Swap API unreachable — not charged, retry shortly");
    }
    if (res.status >= 500 || res.status === 429) throw new Error(`0x Swap API unavailable (${res.status}) — not charged, retry shortly`);
    const q = (await res.json().catch(() => ({}))) as ZeroExQuote;
    if (!res.ok) throw new Error(`No swap: ${q.message || q.name || res.status} — not charged`);
    if (q.liquidityAvailable === false || !q.transaction || !q.buyAmount) {
      throw new Error(`No route: 0x found no liquidity for ${sell.symbol} → ${buy.symbol} at this size — not charged`);
    }
    return q;
  };

  // LCX Liberty DEX beside 0x. "lcx" asks 0x only if LCX fails; "best" and compare
  // ask both at once. Any LCX failure (no_route, insufficient_liquidity, a check in
  // base-swap-lcx.ts) leaves 0x serving; with 0x failing too, 0x's error stands.
  const provider = baseSwapProvider();
  const compare = Boolean(process.env.LCX_API_KEY) && process.env.BASE_SWAP_COMPARE === "1";
  const failed = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
  const lcxAsk =
    provider !== "0x" || compare
      ? lcxBaseQuote({
          key: process.env.LCX_API_KEY || "",
          sellToken: sell.address,
          buyToken: buy.address,
          sellAmount,
          taker,
          slippageBps: slippage,
          // LCX charges this recipient only once LCX has registered its fee on-chain; until then 0 bps.
          integrator: fee?.recipient ?? null,
          maxFeeBps: fee?.bps ?? 0,
        }).catch(failed)
      : null;
  const zxAsk = provider === "lcx" && !compare ? null : quote0x().catch(failed);
  const lcx = await lcxAsk;
  const zx = (await zxAsk) ?? (lcx instanceof Error ? await quote0x().catch(failed) : null);
  const lcxQ = lcx instanceof Error ? null : lcx;
  const zxQ = zx instanceof Error ? null : zx;
  // Both buyAmounts are what the taker receives, after that provider's own fee.
  const viaLcx =
    lcxQ !== null && (provider === "lcx" || (provider === "best" && (zxQ === null || BigInt(lcxQ.buyAmount ?? 0) > BigInt(zxQ.buyAmount ?? 0))));
  const feeBps = viaLcx ? (lcxQ?.feeBps ?? 0) : (fee?.bps ?? 0);
  if (compare) {
    const out = (r: ZeroExQuote | Error | null, bps: number) =>
      r === null ? null : r instanceof Error ? { error: r.message } : { buyAmount: r.buyAmount, minBuyAmount: r.minBuyAmount, feeBps: bps, fee: r.fees?.integratorFee?.amount ?? "0" };
    const diff = lcxQ && zxQ ? Number(((BigInt(lcxQ.buyAmount ?? 0) - BigInt(zxQ.buyAmount ?? 0)) * 10_000n) / BigInt(zxQ.buyAmount || 1)) : null;
    console.log(
      `[base-swap] compare ${JSON.stringify({ sell: sell.symbol, buy: buy.symbol, amount: formatUnits(sellAmount, sell.decimals), provider, served: viaLcx ? "lcx" : "0x", zeroEx: out(zx, fee?.bps ?? 0), lcx: out(lcx, lcxQ?.feeBps ?? 0), lcxVs0xBps: diff })}`,
    );
  }
  const q = viaLcx ? lcxQ : zxQ;
  if (!q?.transaction || !q.buyAmount) throw zx; // 0x's own not-charged error

  const fmt = (raw: string | undefined, d: number) => (raw ? formatUnits(BigInt(raw), d) : null);
  // Book it for /stats — except the daily discovery probe, which quotes for a wallet it does not own,
  // and quotes that cannot be sent as they stand: a wallet short of funds, or one that must approve
  // first (the quote taken after the approval is the one that gets booked, so a swap counts once).
  if (taker.toLowerCase() !== "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" && !q.issues?.balance && !q.issues?.allowance) {
    // EURC excluded: it is a EUR stablecoin, and booking its amount as `usd`
    // overstated every EURC-sell quote in the ledger by the FX rate.
    const stable = /^(USDC|USDBC|DAI)$/i.test(sell.symbol);
    await import("./near-swap-ledger")
      .then((m) =>
        m.recordBaseSwapQuote({
          t: new Date().toISOString(),
          sell: sell.symbol,
          buy: buy.symbol,
          amount: formatUnits(sellAmount, sell.decimals),
          usd: stable ? Number(formatUnits(sellAmount, sell.decimals)) : null,
          feeBps,
          provider: viaLcx ? "lcx" : "0x",
        }),
      )
      .catch(() => {});
  }
  // 0x takes the fee in feeToken; LCX in the token bought.
  const feeDec = feeToken === sell.address && !viaLcx ? sell.decimals : buy.decimals;
  const feeSym = feeToken === sell.address && !viaLcx ? sell.symbol : buy.symbol;
  const allowance = q.issues?.allowance ?? null;
  const short = q.issues?.balance ?? null;

  const steps: string[] = [];
  if (short) steps.push(`Your wallet holds ${fmt(short.actual, sell.decimals)} ${sell.symbol}; the swap needs ${fmt(short.expected, sell.decimals)}. Top up first.`);
  if (allowance) {
    steps.push(
      `Approve once: call approve(${allowance.spender}, amount) on ${sell.symbol} (${sell.address}) from ${taker}. The spender is ${!viaLcx ? "0x's AllowanceHolder contract" : allowance.spender.toLowerCase() === FEE_CONTRACT.toLowerCase() ? "LCX Liberty DEX's fee contract, which swaps through its router" : "the LCX Liberty DEX router"}.`,
    );
  }
  steps.push(`Send the transaction below from ${taker} on Base (chainId 8453). It reverts, costing only gas, if the price moves beyond ${slippage / 100}%.`);

  return {
    chain: "base" as const,
    checkedAt: new Date().toISOString(),
    router: viaLcx ? "LCX Liberty DEX router" : "0x Swap API (AllowanceHolder)",
    sell: { symbol: sell.symbol, address: sell.address, amount: formatUnits(sellAmount, sell.decimals), amountBaseUnits: sellAmount.toString() },
    buy: { symbol: buy.symbol, address: buy.address, amount: fmt(q.buyAmount, buy.decimals), minAmount: fmt(q.minBuyAmount, buy.decimals) },
    route: (q.route?.fills ?? []).map((f) => ({ source: f.source, sharePct: Number(f.proportionBps) / 100 })),
    fees: {
      integratorFeeBps: feeBps,
      integratorFee: q.fees?.integratorFee ? `${fmt(q.fees.integratorFee.amount, feeDec)} ${feeSym}` : null,
      zeroExFee: q.fees?.zeroExFee ? `${fmt(q.fees.zeroExFee.amount, q.fees.zeroExFee.token.toLowerCase() === buy.address.toLowerCase() ? buy.decimals : sell.decimals)} ${q.fees.zeroExFee.token.toLowerCase() === buy.address.toLowerCase() ? buy.symbol : sell.symbol}` : null,
      networkFeeEth: q.totalNetworkFee ? formatUnits(BigInt(q.totalNetworkFee), 18) : null,
    },
    needsApproval: allowance ? { token: sell.address, spender: allowance.spender } : null,
    insufficientBalance: Boolean(short),
    tokenSafety: safety,
    transaction: {
      chainId: 8453,
      from: taker,
      to: q.transaction.to,
      data: q.transaction.data,
      value: q.transaction.value ?? "0",
      gas: q.transaction.gas ?? null,
    },
    steps,
    note: "Quotes expire quickly — send within about a minute, or ask again.",
  };
}
