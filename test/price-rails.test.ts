import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Both payment rails must quote the same price, and they must do it from the
 * same code.
 *
 * They did not. When `url-to-json` was split by mode — $0.01 for a default
 * extraction, $0.06 for `list=true`, whose 8000-token budget costs us about
 * $0.044 in model spend — the uplift was added to the x402 challenge branch
 * only. The credit rail kept debiting the declared $0.01, so a prepaid caller
 * bought the expensive mode for a sixth of its price while the response
 * reported `chargedUsd: 0.01` back to them. A $0.25 credit pack was worth
 * roughly $1.10 of Anthropic spend to anyone who noticed.
 *
 * Nothing caught it because the two rails each computed the price themselves,
 * and a repricing only has to touch one of them to be wrong. So the test is not
 * "is the number right today" — it is that there is exactly one place the
 * number can come from.
 */
const src = readFileSync(new URL("../src/app/api/x402/[service]/route.ts", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("one price, both rails", () => {
  it("computes the price in a single shared function", () => {
    expect(code).toMatch(/async function effectivePriceFor\(/);
  });

  it("the credit rail debits that function's answer, not the declared price", () => {
    // The regression in one line: `priceCents(service.price)` ignores every
    // per-request rule.
    expect(code).toMatch(/const cents = priceCents\(await effectivePriceFor\(service, req\)\)/);
    expect(code, "the bare declared price must not be debited directly").not.toMatch(
      /let cents = priceCents\(service\.price\)/,
    );
  });

  it("the x402 challenge quotes that function's answer too", () => {
    expect(code).toMatch(/const effectivePrice = await effectivePriceFor\(service, req\)/);
  });

  it("no rail re-derives a per-service price on its own", () => {
    // Each of these appearing outside effectivePriceFor means a second source of
    // truth has grown back.
    const fn = code.slice(code.indexOf("async function effectivePriceFor("), code.indexOf("async function attachRetention"));
    const outside = code.replace(fn, "");
    expect(outside, "url-to-json mode uplift belongs in the shared function").not.toMatch(/\$0\.06/);
    expect(outside, "ai-token-report coupon price belongs there too").not.toMatch(/effectivePrice = "\$0\.05"/);
    expect(outside).not.toMatch(/cents = 5;/);
  });

  it("keeps the list-mode test identical to the one the handler uses", () => {
    // If these drift, we charge for one mode and serve the other.
    const routeRe = code.match(/\/\^\(true\|1\|yes\)\$\/i/g) ?? [];
    expect(routeRe.length, "exactly one list-mode test in the route").toBe(1);
    const ai = readFileSync(new URL("../src/lib/ai.ts", import.meta.url), "utf8");
    expect(ai, "and ai.ts must use the same one").toMatch(/\/\^\(true\|1\|yes\)\$\/i/);
  });
});

describe("the facilitator handshake happens once, not per request", () => {
  /**
   * `withX402` builds a fresh wrapper per call and its `isInitialized` flag lives
   * in that wrapper's closure, so the default `syncFacilitatorOnStart = true`
   * re-ran `initialize()` on every request. That clears `supportedResponsesMap`
   * on the SHARED server and then awaits a network call — any concurrent request
   * in that window found an empty map and threw, which surfaced as a 503.
   */
  it("passes syncFacilitatorOnStart = false at the call site", () => {
    expect(code).toMatch(/withX402\(handler, routeConfig, server, undefined, undefined, false\)/);
  });

  it("initialises the shared server exactly once, and retries a failed init", () => {
    const server = readFileSync(new URL("../src/lib/x402-server.ts", import.meta.url), "utf8");
    expect(server).toMatch(/initOnce = server\.initialize\(\)/);
    // A cached rejected promise would poison the instance forever.
    expect(server).toMatch(/initOnce = undefined/);
    expect(server).toMatch(/export async function getResourceServer/);
  });
});
