import { describe, it, expect, afterEach, vi } from "vitest";
import { nearSwap, nearSwapStatus, swapFee } from "@/lib/near-swap";
import { _resetNearCaches } from "@/lib/near-rpc";
import { stubNear } from "./stubs/near-stub";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetNearCaches();
});

const TOKENS = [
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 5, contractAddress: "wrap.near" },
  { assetId: "nep141:usdc.near", decimals: 6, blockchain: "near", symbol: "USDC", price: 1, contractAddress: "usdc.near" },
  { assetId: "nep141:ghost.near", decimals: 18, blockchain: "near", symbol: "GHOST", price: 1, contractAddress: "ghost.near" },
];

const QUOTE = {
  correlationId: "c-1",
  quote: {
    depositAddress: "dep123.near",
    amountIn: "100000000",
    amountInFormatted: "100",
    amountInUsd: "100",
    amountOut: "19900000000000000000000000",
    amountOutFormatted: "19.9",
    amountOutUsd: "99.5",
    minAmountOut: "19700000000000000000000000",
    deadline: "2026-09-26T18:00:00Z",
    timeEstimate: 20,
  },
};

describe("nearSwap", () => {
  it("returns a deposit address from a live quote, without a fee when none is configured", async () => {
    let sent: Record<string, unknown> = {};
    stubNear({ tokens: TOKENS, quote: (b) => ((sent = b), QUOTE) });
    const r = await nearSwap({ from: "USDC", to: "NEAR", amount: "100", recipient: "alice.near", refundTo: "alice.near" });
    expect(sent).toMatchObject({ dry: false, swapType: "EXACT_INPUT", originAsset: "nep141:usdc.near", destinationAsset: "nep141:wrap.near", amount: "100000000", recipientType: "DESTINATION_CHAIN", refundType: "ORIGIN_CHAIN" });
    expect(sent.appFees).toBeUndefined();
    expect(r).toMatchObject({ deposit: { address: "dep123.near", amount: "100", asset: "USDC" }, amountOut: "19.9", minAmountOut: "19.7", distributionFeeBps: 0 });
    expect(r.next[1]).toContain("near-swap-status?depositAddress=dep123.near");
  });

  it("attaches the distribution fee when configured, capped at 1%", async () => {
    vi.stubEnv("NEAR_INTENTS_FEE_RECIPIENT", "fees.near");
    vi.stubEnv("NEAR_INTENTS_FEE_BPS", "500");
    expect(swapFee()).toEqual({ recipient: "fees.near", bps: 100 });
    let sent: Record<string, unknown> = {};
    stubNear({ tokens: TOKENS, quote: (b) => ((sent = b), QUOTE) });
    await nearSwap({ from: "USDC", to: "NEAR", amount: "100", recipient: "alice.near", refundTo: "alice.near" });
    expect(sent.appFees).toEqual([{ recipient: "fees.near", fee: 100 }]);
  });

  it("refuses to hand out a deposit address for a STOP token unless forced", async () => {
    stubNear({ tokens: TOKENS, accounts: {}, quote: () => QUOTE });
    await expect(nearSwap({ from: "USDC", to: "ghost.near", amount: "10", recipient: "alice.near", refundTo: "alice.near" })).rejects.toThrow(/Refused.*not charged/);
    const r = await nearSwap({ from: "USDC", to: "ghost.near", amount: "10", recipient: "alice.near", refundTo: "alice.near", force: "1" });
    expect(r.tokenSafety?.verdict).toBe("STOP");
  });

  it("a rejected quote is a not-charged error", async () => {
    stubNear({ tokens: TOKENS, quote: () => new Response(JSON.stringify({ message: "Amount is too low" }), { status: 400 }) });
    await expect(nearSwap({ from: "USDC", to: "NEAR", amount: "0.01", recipient: "alice.near", refundTo: "alice.near" })).rejects.toThrow(/Amount is too low — not charged/);
  });

  it("can take the deposit inside NEAR Intents", async () => {
    let sent: Record<string, unknown> = {};
    stubNear({ tokens: TOKENS, quote: (b) => ((sent = b), QUOTE) });
    await nearSwap({ from: "USDC", to: "NEAR", amount: "100", recipient: "alice.near", refundTo: "alice.near", depositType: "intents" });
    expect(sent).toMatchObject({ depositType: "INTENTS", refundType: "INTENTS", recipientType: "DESTINATION_CHAIN" });
  });

  it("warns that a fresh implicit deposit account may need 0.01 NEAR first", async () => {
    stubNear({ tokens: TOKENS, quote: () => ({ ...QUOTE, quote: { ...QUOTE.quote, depositAddress: "d".repeat(64) } }) });
    const r = await nearSwap({ from: "USDC", to: "NEAR", amount: "100", recipient: "alice.near", refundTo: "alice.near" });
    expect(r.next.join(" ")).toMatch(/0\.01 NEAR first/);
  });

  it("requires recipient and refundTo", async () => {
    await expect(nearSwap({ from: "USDC", to: "NEAR", amount: "1", refundTo: "a.near" })).rejects.toThrow(/recipient/);
    await expect(nearSwap({ from: "USDC", to: "NEAR", amount: "1", recipient: "a.near" })).rejects.toThrow(/refundTo/);
  });
});

describe("nearSwapStatus", () => {
  it("reads a swap's progress", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "SUCCESS", updatedAt: "t", swapDetails: { amountInFormatted: "100", amountOutFormatted: "19.9", destinationChainTxHashes: [{ hash: "h", explorerUrl: "https://x/h" }] } }))));
    expect(await nearSwapStatus({ depositAddress: "dep123.near" })).toMatchObject({ status: "SUCCESS", done: true, amountOut: "19.9", destinationTxs: ["https://x/h"] });
  });

  it("an unknown deposit address is an answer, not an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "not found" }), { status: 404 })));
    expect(await nearSwapStatus({ depositAddress: "0x0000000000000000000000000000000000000000" })).toMatchObject({ status: "NOT_FOUND", done: false });
  });
});
