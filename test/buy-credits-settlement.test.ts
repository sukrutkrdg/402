import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A credit pack is only real once its payment settles.
 *
 * withX402 runs the handler FIRST and settles on its response. buy-credits used
 * to mint, book the sale and link the token to the paying wallet inside the
 * handler, so one signed $20 authorization sent ten times in parallel minted ten
 * balances: one settled, nine failed — and all ten were recoverable onto one
 * token through /api/credits/recover, because the wallet link was already made.
 *
 * Now the handler only mints and remembers; after withX402 answers, a settled
 * purchase is booked and linked, and an unsettled one is deleted. A replay guard
 * on the payment signature stops the parallel copies before they mint at all.
 */
const src = readFileSync(new URL("../src/app/api/x402/[service]/route.ts", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("buy-credits settles before it counts", () => {
  const handler = code.slice(code.indexOf("const handler = async"), code.indexOf("const routeConfig"));

  it("does not link the token to a wallet or book revenue inside the handler", () => {
    expect(handler).not.toMatch(/linkCreditOwner\(/);
    expect(handler).not.toMatch(/revenue-cents:buy-credits/);
  });

  it("finishes the purchase only after withX402 has answered, keyed on the settled status", () => {
    const call = code.indexOf("res = await guarded(req)");
    expect(call).toBeGreaterThan(0);
    const settle = code.indexOf("settleCreditPurchase(mint.pending, res.status < 400)");
    expect(settle).toBeGreaterThan(call);
  });

  it("voids the balance when settlement fails or the call throws", () => {
    const fn = code.slice(code.indexOf("async function settleCreditPurchase("));
    expect(fn.slice(0, 400)).toMatch(/if \(!settled\) \{\s*await voidCredits\(m\.token\)/);
    expect(code).toMatch(/catch \(err\) \{\s*if \(mint\.pending\) await voidCredits\(mint\.pending\.token\)/);
  });

  it("links and books only on the settled branch", () => {
    const fn = code.slice(code.indexOf("async function settleCreditPurchase("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body.indexOf("bookCreditSale(")).toBeGreaterThan(body.indexOf("if (!settled)"));
    expect(body.indexOf("linkCreditOwner(")).toBeGreaterThan(body.indexOf("if (!settled)"));
  });

  it("refuses a second concurrent use of the same payment signature, and frees it when unsettled", () => {
    expect(code).toMatch(/kvSetNx\(replayKey, \d+\)/);
    expect(code).toMatch(/status: 409/);
    expect(code).toMatch(/if \(replayKey && res\.status >= 400\) await kvDel\(replayKey\)/);
  });
});
