import { describe, it, expect, afterEach, vi } from "vitest";
import { baseSwap, baseSwapFee } from "@/lib/base-swap";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const TAKER = "0x1111111111111111111111111111111111111111";
const QUOTE = {
  liquidityAvailable: true,
  buyAmount: "3000000000000000",
  minBuyAmount: "2970000000000000",
  sellAmount: "10000000",
  transaction: { to: "0xallowanceholder", data: "0xdeadbeef", value: "0", gas: "200000" },
  issues: { allowance: { actual: "0", spender: "0x0000000000001fF3684f28c67538d4D072C22734" }, balance: null },
  fees: { integratorFee: { amount: "20000", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, zeroExFee: null },
  route: { fills: [{ source: "Uniswap_V3", proportionBps: "7000" }, { source: "Aerodrome", proportionBps: "3000" }] },
};

function stub0x(answer: unknown, status = 200) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string) => (urls.push(String(u)), new Response(JSON.stringify(answer), { status }))));
  return urls;
}

describe("baseSwap", () => {
  it("returns a signable transaction, the approval step, route and the integrator fee", async () => {
    vi.stubEnv("ZEROX_API_KEY", "k");
    vi.stubEnv("BASE_SWAP_FEE_BPS", "20");
    vi.stubEnv("PAY_TO_ADDRESS", "0x2222222222222222222222222222222222222222");
    const urls = stub0x(QUOTE);
    const r = await baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER });
    const u = new URL(urls[0]);
    expect(u.pathname).toBe("/swap/allowance-holder/quote");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      chainId: "8453",
      sellAmount: "10000000",
      taker: TAKER,
      swapFeeBps: "20",
      swapFeeRecipient: "0x2222222222222222222222222222222222222222",
      swapFeeToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });
    expect(r).toMatchObject({
      buy: { symbol: "ETH", amount: "0.003", minAmount: "0.00297" },
      fees: { integratorFeeBps: 20, integratorFee: "0.02 USDC" },
      needsApproval: { spender: "0x0000000000001fF3684f28c67538d4D072C22734" },
      transaction: { chainId: 8453, to: "0xallowanceholder", data: "0xdeadbeef" },
      route: [{ source: "Uniswap_V3", sharePct: 70 }, { source: "Aerodrome", sharePct: 30 }],
    });
    expect(r.steps[0]).toMatch(/Approve once/);
  });

  it("no fee params when the fee is off", async () => {
    vi.stubEnv("ZEROX_API_KEY", "k");
    expect(baseSwapFee()).toBeNull();
    const urls = stub0x(QUOTE);
    await baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER });
    expect(new URL(urls[0]).searchParams.has("swapFeeBps")).toBe(false);
  });

  it("no liquidity or no key is a not-charged error", async () => {
    await expect(baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER })).rejects.toThrow(/ZEROX_API_KEY\) — not charged/);
    vi.stubEnv("ZEROX_API_KEY", "k");
    stub0x({ liquidityAvailable: false });
    await expect(baseSwap({ sell: "USDC", buy: "ETH", amount: "10", taker: TAKER })).rejects.toThrow(/No route.*not charged/);
  });

  it("requires a taker wallet", async () => {
    vi.stubEnv("ZEROX_API_KEY", "k");
    await expect(baseSwap({ sell: "USDC", buy: "ETH", amount: "10" })).rejects.toThrow(/taker/);
  });
});
