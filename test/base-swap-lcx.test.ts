import { describe, it, expect, afterEach, vi } from "vitest";
import { encodeFunctionData, toFunctionSelector } from "viem";
import { baseSwap, baseSwapProvider } from "@/lib/base-swap";
import { lcxCalldataProblem, LCX_ROUTER_ABI } from "@/lib/base-swap-lcx";
import { kvLRange } from "@/lib/kv";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Hex = `0x${string}`;
const TAKER: Hex = "0x1111111111111111111111111111111111111111";
const FEE_TO: Hex = "0x2222222222222222222222222222222222222222";
const OTHER: Hex = "0x3333333333333333333333333333333333333333";
const ROUTER: Hex = "0x0000000000b1ae06c96aB73FF4360d7AeAaB56F0";
const USDC: Hex = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH: Hex = "0x4200000000000000000000000000000000000006";
const ZERO: Hex = "0x0000000000000000000000000000000000000000";
const BEBOP: Hex = "0xbbbbbbb520d69a9775e85b458c58c648259fad5f";
const LEGS = [{ amountIn: 10_000_000n, hops: [{ family: 1, pool: OTHER, tokenIn: USDC, tokenOut: WETH, aux: 0n }] }];
const soon = () => BigInt(Math.floor(Date.now() / 1000) + 300);

interface Sale {
  tokenIn: Hex;
  tokenOut: Hex;
  totalIn: bigint;
  minAmountOut: bigint;
  recipient: Hex;
  deadline: bigint;
}
const SALE = (o: Partial<Sale> = {}): Sale => ({ tokenIn: USDC, tokenOut: ZERO, totalIn: 10_000_000n, minAmountOut: 3_069_000_000_000_000n, recipient: TAKER, deadline: soon(), ...o });
const swapSplit = (o: Partial<Sale> = {}) => {
  const s = SALE(o);
  return encodeFunctionData({ abi: LCX_ROUTER_ABI, functionName: "swapSplit", args: [s.tokenIn, s.tokenOut, s.totalIn, s.minAmountOut, s.recipient, s.deadline, LEGS] });
};
const withFee = (integrator: Hex, o: Partial<Sale> = {}) => encodeFunctionData({ abi: LCX_ROUTER_ABI, functionName: "swapSplitWithFee", args: [{ ...SALE(o), integrator }, LEGS] });
const maker = (m: { target: Hex; spender: Hex; amountIn: bigint; data?: Hex }) => {
  const s = SALE();
  return encodeFunctionData({
    abi: LCX_ROUTER_ABI,
    functionName: "makerSwap",
    args: [{ ...s, amountIn: s.totalIn }, LEGS, { minOut: 0n, data: "0x1234", ...m }, LEGS],
  });
};
const WANT = { tokenIn: USDC, tokenOut: ZERO, amountIn: 10_000_000n, recipient: TAKER, minOut: 3_069_000_000_000_000n, integrator: null as string | null };

const QUOTE_0X = {
  liquidityAvailable: true,
  buyAmount: "3000000000000000",
  minBuyAmount: "2970000000000000",
  sellAmount: "10000000",
  transaction: { to: "0xallowanceholder", data: "0xdeadbeef", value: "0", gas: "200000" },
  issues: { allowance: { actual: "0", spender: "0x0000000000001fF3684f28c67538d4D072C22734" }, balance: null },
  fees: { integratorFee: null, zeroExFee: { amount: "15000", token: USDC } },
  totalNetworkFee: "2894596101887",
  route: { fills: [{ source: "Uniswap_V3", proportionBps: "10000" }] },
};

/** An LCX /v1/swap answer for 10 USDC → ETH (or `native` = 0.01 ETH → USDC), as the API shapes it. */
function lcxAnswer(o: { data?: string; to?: string; chainId?: number; minAmountOut?: string | null; value?: string; fee?: object; native?: boolean } = {}) {
  const [tokenIn, tokenOut, amountIn, out, min] = o.native
    ? [ZERO, USDC, "10000000000000000", "18022465", "17842240"]
    : [USDC, ZERO, "10000000", "3100000000000000", "3069000000000000"];
  const data = o.data ?? (o.native ? swapSplit({ tokenIn: ZERO, tokenOut: USDC, totalIn: 10n ** 16n, minAmountOut: 17_842_240n }) : swapSplit());
  return {
    success: true,
    data: {
      quote: {
        quoteId: "q_test",
        chainId: 8453,
        input: { amount: amountIn, token: tokenIn },
        output: { amount: out, minimumAmount: min, token: tokenOut },
        fee: { bps: 0, amount: "0", token: tokenOut, integrator: ZERO, integratorSource: "none", grossAmount: out, ...o.fee },
        gasEstimateWei: "5100000000000",
        spender: ROUTER,
        routes: [
          { amountIn: o.native ? amountIn : "7000000", hops: [{ dex: "elfomo" }, { dex: "aerodrome-cl-3" }] },
          ...(o.native ? [] : [{ amountIn: "3000000", hops: [{ dex: "uniswap-v3" }] }]),
        ],
      },
      transaction: {
        to: o.to ?? ROUTER,
        data,
        value: o.value ?? (o.native ? amountIn : "0"),
        gas: "367938",
        chainId: o.chainId ?? 8453,
        routerDeployed: true,
        ...(o.minAmountOut === null ? {} : { minAmountOut: o.minAmountOut ?? min }),
      },
    },
  };
}

/** lcxAnswer() with fields of its quote replaced. */
function withQuote(patch: object) {
  const a = lcxAnswer();
  return { ...a, data: { ...a.data, quote: { ...a.data.quote, ...patch } } };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Routes fetch by host: 0x, LCX /v1/swap and /v1/allowance, and the Base RPC (the taker's balance). */
function stub(a: { zeroEx?: unknown; lcx?: unknown; lcxStatus?: number; lcxThrows?: boolean; allowance?: object; balance?: bigint } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string, init?: RequestInit) => {
      const url = String(u);
      calls.push({ url, init });
      if (url.startsWith("https://api.0x.org/")) return json(a.zeroEx ?? QUOTE_0X);
      if (url.startsWith("https://swap-api.lcx.com/v1/swap")) {
        if (a.lcxThrows) throw new TypeError("fetch failed");
        return json(a.lcx ?? lcxAnswer(), a.lcxStatus ?? 200);
      }
      if (url.startsWith("https://swap-api.lcx.com/v1/allowance")) {
        return json({ success: true, data: { required: true, allowance: "0", spender: ROUTER, ...a.allowance } });
      }
      const rpc = JSON.parse(String(init?.body)) as { id: number };
      return json({ jsonrpc: "2.0", id: rpc.id, result: `0x${(a.balance ?? 10n ** 24n).toString(16).padStart(64, "0")}` });
    }),
  );
  return calls;
}
const hits = <C extends { url: string }>(calls: C[], prefix: string) => calls.filter((c) => c.url.startsWith(prefix));
const ZX = "https://api.0x.org/";
const LCX_SWAP = "https://swap-api.lcx.com/v1/swap";

function lcxOn(provider = "lcx") {
  vi.stubEnv("ZEROX_API_KEY", "k");
  vi.stubEnv("LCX_API_KEY", "lk");
  vi.stubEnv("BASE_SWAP_PROVIDER", provider);
}

describe("baseSwapProvider", () => {
  it("is 0x unless LCX_API_KEY is set and lcx or best is asked for", () => {
    expect(baseSwapProvider()).toBe("0x");
    vi.stubEnv("BASE_SWAP_PROVIDER", "lcx");
    expect(baseSwapProvider()).toBe("0x");
    vi.stubEnv("LCX_API_KEY", "lk");
    expect(baseSwapProvider()).toBe("lcx");
    vi.stubEnv("BASE_SWAP_PROVIDER", "BEST");
    expect(baseSwapProvider()).toBe("best");
    vi.stubEnv("BASE_SWAP_PROVIDER", "kyber");
    expect(baseSwapProvider()).toBe("0x");
  });
});

describe("baseSwap with LCX Liberty DEX", () => {
  it("without LCX_API_KEY only 0x is asked", async () => {
    vi.stubEnv("ZEROX_API_KEY", "k");
    vi.stubEnv("BASE_SWAP_PROVIDER", "lcx");
    vi.stubEnv("BASE_SWAP_COMPARE", "1");
    const calls = stub();
    const r = await baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER });
    expect(r.router).toBe("0x Swap API (AllowanceHolder)");
    expect(calls.every((c) => c.url.startsWith(ZX))).toBe(true);
  });

  it("lcx serves LCX's transaction, approval to the router /v1/allowance named, route and fees", async () => {
    lcxOn();
    const calls = stub();
    const r = await baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER });
    const req = hits(calls, LCX_SWAP)[0];
    expect(JSON.parse(String(req.init?.body))).toEqual({ chainId: 8453, tokenIn: USDC, tokenOut: ZERO, amountIn: "10000000", taker: TAKER, slippageBps: 100 });
    expect((req.init?.headers as Record<string, string>).authorization).toBe("Bearer lk");
    const allowance = new URL(hits(calls, "https://swap-api.lcx.com/v1/allowance")[0].url);
    expect(Object.fromEntries(allowance.searchParams)).toEqual({ chainId: "8453", token: USDC, taker: TAKER, amount: "10000000" });
    expect(hits(calls, ZX)).toHaveLength(0);
    expect(r).toMatchObject({
      router: "LCX Liberty DEX router",
      buy: { symbol: "ETH", amount: "0.0031", minAmount: "0.003069" },
      route: [{ source: "elfomo > aerodrome-cl-3", sharePct: 70 }, { source: "uniswap-v3", sharePct: 30 }],
      fees: { integratorFeeBps: 0, integratorFee: null, zeroExFee: null, networkFeeEth: "0.0000051" },
      needsApproval: { token: USDC, spender: ROUTER },
      insufficientBalance: false,
      transaction: { chainId: 8453, from: TAKER, to: ROUTER, value: "0", gas: "367938" },
    });
    expect(r.steps[0]).toMatch(/Approve once: call approve\(0x0000000000b1ae06c96aB73FF4360d7AeAaB56F0, amount\).*LCX Liberty DEX router/);
  });

  it("sells native ETH as the zero address, carries the value, needs no approval and is booked as lcx", async () => {
    lcxOn();
    const calls = stub({ lcx: lcxAnswer({ native: true }), allowance: { required: false, allowance: null } });
    const r = await baseSwap({ sell: "ETH", buy: "USDC", amount: "0.01", taker: TAKER });
    expect(JSON.parse(String(hits(calls, LCX_SWAP)[0].init?.body))).toMatchObject({ tokenIn: ZERO, tokenOut: USDC, amountIn: "10000000000000000" });
    expect(new URL(hits(calls, "https://swap-api.lcx.com/v1/allowance")[0].url).searchParams.get("token")).toBe(ZERO);
    expect(r).toMatchObject({ router: "LCX Liberty DEX router", needsApproval: null, transaction: { value: "10000000000000000" }, buy: { amount: "18.022465" } });
    expect(JSON.parse((await kvLRange("base:swap:recent", 0, 0))[0])).toMatchObject({ sell: "ETH", buy: "USDC", feeBps: 0, provider: "lcx" });
  });

  it("a wallet short of the amount is told to top up", async () => {
    lcxOn();
    stub({ balance: 5_000_000n });
    const r = await baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER });
    expect(r.insufficientBalance).toBe(true);
    expect(r.steps[0]).toMatch(/holds 5 USDC; the swap needs 10/);
  });

  it("names the fee recipient as integrator and reports only the fee LCX returned", async () => {
    lcxOn();
    vi.stubEnv("BASE_SWAP_FEE_BPS", "20");
    vi.stubEnv("BASE_SWAP_FEE_RECIPIENT", FEE_TO);
    // Not registered with LCX yet: the fee block reads 0 bps, so none is claimed.
    let calls = stub();
    let r = await baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER });
    expect(JSON.parse(String(hits(calls, LCX_SWAP)[0].init?.body)).integrator).toBe(FEE_TO);
    expect(r.fees).toMatchObject({ integratorFeeBps: 0, integratorFee: null });
    // Registered: the fee is in the token bought, and the calldata pays it to FEE_TO.
    calls = stub({ lcx: lcxAnswer({ data: withFee(FEE_TO), fee: { bps: 20, amount: "6200000000000", integrator: FEE_TO } }) });
    r = await baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER });
    expect(r).toMatchObject({ router: "LCX Liberty DEX router", fees: { integratorFeeBps: 20, integratorFee: "0.0000062 ETH" } });
    // More than BASE_SWAP_FEE_BPS, even to the right recipient: not served.
    vi.spyOn(console, "error").mockImplementation(() => {});
    stub({ lcx: lcxAnswer({ data: withFee(FEE_TO), fee: { bps: 30, amount: "9300000000000", integrator: FEE_TO } }) });
    r = await baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER });
    expect(r.router).toBe("0x Swap API (AllowanceHolder)");
  });

  // The last column is the refusal base-swap-lcx logs; null for an answer that is simply not a route.
  it.each([
    ["no_route", { lcx: { success: false, code: "no_route", error: "no_route", message: "No route" }, lcxStatus: 400 }, null],
    ["insufficient_liquidity", { lcx: { success: false, code: "insufficient_liquidity", maxAmountIn: "1" }, lcxStatus: 422 }, null],
    ["a 503", { lcx: { success: false, code: "store_unavailable" }, lcxStatus: 503 }, null],
    ["a network error", { lcxThrows: true }, null],
    ["a transaction to another contract", { lcx: lcxAnswer({ to: OTHER }) }, /does not go to the router/],
    ["a spender that differs from /v1/allowance", { allowance: { spender: OTHER } }, /does not go to the router/],
    ["another chain", { lcx: lcxAnswer({ chainId: 1 }) }, /not a Base transaction/],
    ["an unreadable output", { lcx: withQuote({ output: { amount: "3.1e15", minimumAmount: "3069000000000000", token: ZERO } }) }, /no transaction/],
    ["a quote for another amount", { lcx: withQuote({ input: { amount: "9999999", token: USDC } }) }, /different trade/],
    ["no minimum out", { lcx: lcxAnswer({ minAmountOut: null }) }, /no minimum out/],
    ["a minimum out below the quote's", { lcx: lcxAnswer({ minAmountOut: "3000000000000000" }) }, /no minimum out at the quoted floor/],
    ["value on a token sale", { lcx: lcxAnswer({ value: "1" }) }, /value does not match/],
    ["calldata paying someone else", { lcx: lcxAnswer({ data: swapSplit({ recipient: OTHER }) }) }, /recipient is not the taker/],
    ["calldata with a lower floor", { lcx: lcxAnswer({ data: swapSplit({ minAmountOut: 1n }) }) }, /below the quoted floor/],
    ["a fee we did not configure", { lcx: lcxAnswer({ fee: { bps: 30, amount: "1", integrator: OTHER } }) }, /30 bps fee we did not configure/],
  ])("falls through to 0x on %s", async (_why, answers, refusal) => {
    lcxOn();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = stub(answers);
    const r = await baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER });
    expect(r).toMatchObject({ router: "0x Swap API (AllowanceHolder)", transaction: { to: "0xallowanceholder" } });
    expect(hits(calls, ZX)).toHaveLength(1);
    if (refusal) expect(String(err.mock.calls[0]?.[0])).toMatch(refusal);
    else expect(err).not.toHaveBeenCalled();
  });

  it("with both failing, 0x's own error stands", async () => {
    lcxOn();
    stub({ lcx: { success: false, code: "no_route" }, lcxStatus: 400, zeroEx: { liquidityAvailable: false } });
    await expect(baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER })).rejects.toThrow(/No route.*not charged/);
  });

  it("best asks both at once and serves the larger output", async () => {
    lcxOn("best");
    let calls = stub();
    expect((await baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER })).router).toBe("LCX Liberty DEX router");
    expect(hits(calls, ZX)).toHaveLength(1);
    calls = stub({ zeroEx: { ...QUOTE_0X, buyAmount: "3200000000000000" } });
    expect((await baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER })).router).toBe("0x Swap API (AllowanceHolder)");
    expect(hits(calls, LCX_SWAP)).toHaveLength(1);
  });

  it("compare logs both quotes and keeps serving 0x", async () => {
    lcxOn("0x");
    vi.stubEnv("BASE_SWAP_COMPARE", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    stub();
    const r = await baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER });
    expect(r.router).toBe("0x Swap API (AllowanceHolder)");
    const line = String(log.mock.calls[0][0]);
    expect(line).toMatch(/^\[base-swap\] compare /);
    expect(JSON.parse(line.replace("[base-swap] compare ", ""))).toMatchObject({
      sell: "USDC",
      buy: "ETH",
      provider: "0x",
      served: "0x",
      zeroEx: { buyAmount: "3000000000000000", feeBps: 0 },
      lcx: { buyAmount: "3100000000000000", minBuyAmount: "3069000000000000", feeBps: 0, fee: "0" },
      lcxVs0xBps: 333,
    });
  });
});

describe("lcxCalldataProblem", () => {
  it("pins the router's five selectors", () => {
    expect(LCX_ROUTER_ABI.map((f) => toFunctionSelector(f))).toEqual(["0xfc54261d", "0x5e98574a", "0x195e648e", "0x31ab353b", "0xa565fdcc"]);
  });

  it("passes a sale of exactly what was asked", () => {
    expect(lcxCalldataProblem(swapSplit(), WANT)).toBeNull();
    expect(lcxCalldataProblem(swapSplit({ minAmountOut: 4_000_000_000_000_000n }), WANT)).toBeNull();
    expect(lcxCalldataProblem(withFee(ZERO), WANT)).toBeNull();
    expect(lcxCalldataProblem(withFee(FEE_TO), { ...WANT, integrator: FEE_TO })).toBeNull();
    expect(lcxCalldataProblem(maker({ target: BEBOP, spender: BEBOP, amountIn: 4_000_000n }), WANT)).toBeNull();
    expect(lcxCalldataProblem(maker({ target: ZERO, spender: ZERO, amountIn: 0n, data: "0x" }), WANT)).toBeNull();
  });

  it.each([
    ["an unknown function", "0xdeadbeef" + "00".repeat(64), /not an LCX router swap/],
    ["another recipient", swapSplit({ recipient: OTHER }), /recipient/],
    ["another amount", swapSplit({ totalIn: 9_999_999n }), /different amount/],
    ["swapped tokens", swapSplit({ tokenIn: ZERO, tokenOut: USDC }), /different tokens/],
    ["a lower floor", swapSplit({ minAmountOut: 3_068_999_999_999_999n }), /floor/],
    ["a past deadline", swapSplit({ deadline: 1n }), /deadline/],
    ["a fee to an integrator we did not name", withFee(OTHER), /integrator/],
    ["a maker leg outside Bebop", maker({ target: OTHER, spender: OTHER, amountIn: 4_000_000n }), /Bebop/],
    ["a zero-amount maker leg outside Bebop", maker({ target: OTHER, spender: OTHER, amountIn: 0n }), /Bebop/],
    ["a zero-address maker leg that still spends", maker({ target: ZERO, spender: ZERO, amountIn: 1n, data: "0x" }), /Bebop/],
    ["a maker leg spending more than the input", maker({ target: BEBOP, spender: BEBOP, amountIn: 10_000_001n }), /more than the input/],
    [
      "a prop-AMM leg spending more than the input",
      encodeFunctionData({
        abi: LCX_ROUTER_ABI,
        functionName: "swapSplitWithPropAMMSplit",
        args: [{ ...SALE(), integrator: ZERO }, LEGS, LEGS, { venue: OTHER, venueIn: 10_000_001n, venueMinOut: 0n }],
      }),
      /prop-AMM/,
    ],
  ])("refuses %s", (_why, data, reason) => {
    expect(lcxCalldataProblem(data, WANT)).toMatch(reason);
  });
});
