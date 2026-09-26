import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The AI-report coupon is one discount for one call. It used to be read at
 * pricing time and deleted after delivery, so several concurrent calls all saw
 * it and all paid $0.05. Now a call claims it with one atomic DEL; a call that
 * finds it gone pays full price (credits) or is refused before settlement (x402),
 * and a call that does not go through gives it back.
 */
const src = readFileSync(new URL("../src/app/api/x402/[service]/route.ts", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the report coupon is single-use", () => {
  it("claims with an atomic DEL", () => {
    expect(code).toMatch(/kvEval<number>\("return redis\.call\('DEL', KEYS\[1\]\)", \[key\], \[\]\)/);
  });

  it("x402: a second concurrent call at the coupon price is refused before settlement", () => {
    const handler = code.slice(code.indexOf("const handler = async"));
    const claim = handler.indexOf("claimCoupon(request, service)");
    expect(claim).toBeGreaterThan(0);
    expect(claim).toBeLessThan(handler.indexOf("service.handler(p)"));
    expect(handler.slice(claim, claim + 600)).toMatch(/status: 409/);
  });

  it("gives the coupon back when the payment does not settle", () => {
    expect(code).toMatch(/if \(couponHeld\.key && res\.status >= 400\) await kvSet\(couponHeld\.key/);
  });
});
