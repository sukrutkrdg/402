import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/swap/quote/route";
import { _resetNearCaches } from "@/lib/near-rpc";
import { stubNear } from "./stubs/near-stub";

afterEach(() => {
  vi.unstubAllGlobals();
  _resetNearCaches();
});

const TOKENS = [
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 5, contractAddress: "wrap.near" },
  { assetId: "nep141:usdc.near", decimals: 6, blockchain: "near", symbol: "USDC", price: 1, contractAddress: "usdc.near" },
];
const req = (body: unknown) =>
  new NextRequest("https://402.com.tr/api/swap/quote", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 200)}` } });

describe("/api/swap/quote", () => {
  it("returns the deposit address for a person, free", async () => {
    stubNear({ tokens: TOKENS, quote: () => ({ quote: { depositAddress: "dep.near", amountIn: "5000000", amountInFormatted: "5", amountOut: "1", amountOutFormatted: "1", minAmountOut: "1" } }) });
    const r = await POST(req({ from: "USDC", to: "NEAR", amount: "5", recipient: "a.near", refundTo: "a.near" }));
    expect(r.status).toBe(200);
    expect((await r.json()).deposit.address).toBe("dep.near");
  });

  it("a bad request is a 400 with the reason, without 'not charged' wording", async () => {
    stubNear({ tokens: TOKENS });
    const r = await POST(req({ from: "USDC", to: "NEAR", amount: "5", refundTo: "a.near" }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/recipient/);
  });
});
