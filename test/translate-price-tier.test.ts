import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TRANSLATE_LONG_CHARS, translateIsLong } from "@/lib/ai";
import { SERVICES } from "@/lib/services";

/**
 * ai-translate sells a ceiling, so it has to price one.
 *
 * The endpoint advertises 6K characters into ANY language and charged $0.03 flat.
 * `max_tokens` is 6000 because the expensive end of "any" needs it — Hindi and
 * Thai spend several tokens per character where English spends one. On Haiku 4.5
 * ($1/$5 per MTok) a call that actually fills that budget costs $0.030 of output
 * plus its input, against a $0.03 sale: no margin at the exact request the
 * product invites. Ordinary traffic was never close, which is precisely why this
 * could sit in the catalog unnoticed — the loss only appears when someone asks
 * for the thing we advertised.
 *
 * The fix is not a lower cap (that would break the published 6K promise) but a
 * second tier. What this test guards is the part that has bitten us before: the
 * threshold deciding the tier and the threshold deciding the price must be the
 * same one. When `url-to-json` was split by mode, the uplift reached the x402
 * challenge and missed the credit rail, and a $0.25 pack bought $1.10 of model
 * spend (see test/price-rails.test.ts).
 */
const route = readFileSync(new URL("../src/app/api/x402/[service]/route.ts", import.meta.url), "utf8");
const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("translateIsLong", () => {
  it("splits at the exported threshold, inclusive of the cheap tier", () => {
    expect(translateIsLong("a".repeat(TRANSLATE_LONG_CHARS))).toBe(false);
    expect(translateIsLong("a".repeat(TRANSLATE_LONG_CHARS + 1))).toBe(true);
  });

  it("measures the text the handler will actually send — trimmed", () => {
    // The handler trims before clamping, so padding must not buy the long tier
    // and must not be charged for either.
    const padded = "  " + "a".repeat(TRANSLATE_LONG_CHARS) + "   \n";
    expect(translateIsLong(padded)).toBe(false);
  });

  it("treats missing input as the cheap tier rather than throwing", () => {
    expect(translateIsLong("")).toBe(false);
    expect(translateIsLong(undefined as unknown as string)).toBe(false);
  });

  it("leaves room over model cost at both ends", () => {
    // Haiku 4.5: $1/MTok in, $5/MTok out. Worst case is the whole output budget.
    const OUT_PER_TOKEN = 5 / 1_000_000;
    const IN_PER_TOKEN = 1 / 1_000_000;
    // The pessimistic tokenizer: a script that spends a token per character.
    const worstCost = (chars: number, maxOut: number) => chars * IN_PER_TOKEN + maxOut * OUT_PER_TOKEN;
    // Cheap tier can only produce about as many tokens as it was given.
    expect(worstCost(TRANSLATE_LONG_CHARS, TRANSLATE_LONG_CHARS * 1.25)).toBeLessThan(0.03);
    // Long tier can reach the full 6000-token cap on a 6K-character input.
    expect(worstCost(6000, 6000)).toBeLessThan(0.08);
  });
});

describe("the price and the tier come from the same place", () => {
  it("the route asks ai.ts which tier a call is in", () => {
    expect(code).toMatch(/translateIsLong\(/);
    // A second, hand-rolled length test in the route is the drift we are stopping.
    const routeOwnTest = code.match(/\.length\s*>\s*\d{3,}/g) ?? [];
    expect(routeOwnTest, "the route must not re-derive the threshold").toHaveLength(0);
  });

  it("prices it inside the one shared function, so both rails see it", () => {
    const fn = code.slice(
      code.indexOf("async function effectivePriceFor("),
      code.indexOf("async function attachRetention"),
    );
    expect(fn).toMatch(/service\.id === "ai-translate"/);
    expect(fn).toMatch(/\$0\.08/);
    const outside = code.replace(fn, "");
    expect(outside, "the uplift must not appear anywhere else").not.toMatch(/\$0\.08/);
  });
});

describe("what we charge is what we published", () => {
  const translate = SERVICES.find((s) => s.id === "ai-translate")!;

  it("keeps the declared price as the cheap tier", () => {
    expect(translate.price).toBe("$0.03");
  });

  it("tells the buyer about the second tier before they pay", () => {
    // The catalog description is what an agent reads when deciding; a price it
    // cannot predict from there is a surprise at settlement time.
    expect(translate.description).toMatch(/\$0\.08/);
    expect(translate.description).toMatch(new RegExp(String(TRANSLATE_LONG_CHARS).replace(/\B(?=(\d{3})+$)/g, ",")));
  });
});
