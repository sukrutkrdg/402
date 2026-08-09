import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { priceCents } from "../src/lib/price";

/** Declared prices, read from source — importing the registry would pull in every
 *  server-only handler behind it. */
function declaredPrices(): Record<string, string> {
  const src = readFileSync(new URL("../src/lib/services.ts", import.meta.url), "utf8");
  const out: Record<string, string> = {};
  for (const chunk of src.split(/\r?\n {2}\{\r?\n/).slice(1)) {
    const body = chunk.split(/\r?\n {2}\},?\r?\n/)[0];
    const id = body.match(/^\s*id:\s*"([\w-]+)",/m)?.[1];
    const price = body.match(/^\s*price:\s*"([^"]+)"/m)?.[1];
    if (id && price && !/^\s*\/\//.test(body)) out[id] = price;
  }
  return out;
}

/**
 * A price that rounds to zero cents is a service given away.
 *
 * Both paid rails charge in whole cents. The x402 rail rounded UP with a floor of
 * one; the on-chain rail rounded to NEAREST with no floor, so `$0.002` became 0¢,
 * the amount-check `paidMicro < 0n` was false for a payment of nothing, and 11
 * services — the entire primitives set plus url-extract, fx-convert,
 * business-days and inflation-adjust — could be redeemed with any recent
 * successful transaction hash on Base. No USDC, no relation to us.
 *
 * The two rails now share one implementation, and these tests fail if a second
 * copy appears or if the floor is ever removed.
 */
describe("price floor", () => {
  it("never rounds a real price down to a free call", () => {
    const prices = declaredPrices();
    expect(Object.keys(prices).length).toBeGreaterThan(100);
    for (const [id, price] of Object.entries(prices)) {
      const usd = parseFloat(price.replace(/[^0-9.]/g, "")) || 0;
      if (usd <= 0) continue;
      expect(priceCents(price), `${id} at ${price} would be free`).toBeGreaterThanOrEqual(1);
    }
  });

  it("rounds up rather than to nearest", () => {
    // The distinction that mattered: round-to-nearest sends 0.2¢ to zero.
    expect(priceCents("$0.002")).toBe(1);
    expect(priceCents("$0.005")).toBe(1);
    expect(priceCents("$0.011")).toBe(2);
    expect(priceCents("$0.03")).toBe(3);
    expect(priceCents("$0.10")).toBe(10);
  });

  it("treats a missing or nonsense price as zero, not as one cent", () => {
    // A floor of 1 must apply to real prices only — inventing a charge for an
    // unparsable price would be its own bug.
    expect(priceCents("")).toBe(0);
    expect(priceCents("free")).toBe(0);
    expect(priceCents("$0")).toBe(0);
  });

  it("is defined once — no rail carries its own copy", () => {
    // The whole defect was two implementations drifting apart.
    for (const route of ["../src/app/api/x402/[service]/route.ts", "../src/app/api/onchain/[service]/route.ts"]) {
      const src = readFileSync(new URL(route, import.meta.url), "utf8");
      expect(/function\s+priceCents/.test(src), `${route} declares its own priceCents`).toBe(false);
      expect(src, `${route} must import the shared one`).toContain('from "@/lib/price"');
    }
  });
});

describe("the on-chain rail refuses an x402 settlement", () => {
  it("checks for the AuthorizationUsed log", () => {
    // An x402 settlement is transferWithAuthorization: a Transfer to payTo that
    // any observer can see and replay by hash. USDC emits AuthorizationUsed
    // alongside it; a wallet's own transfer never does. Without this check the
    // rail hands a stranger a free report for every settlement we earn.
    const src = readFileSync(new URL("../src/app/api/onchain/[service]/route.ts", import.meta.url), "utf8");
    // keccak256("AuthorizationUsed(address,bytes32)")
    expect(src).toContain("0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5");
    expect(src).toMatch(/topics\[0\]/);
  });
});
