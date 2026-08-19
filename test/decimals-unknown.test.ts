import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Eighteen is not a safe default; it is a fabricated number.
 *
 * Both wallet-balance paths reached for `decimals ?? 18` when the scale could
 * not be read. On a 6-decimal token — USDC, the very token this marketplace is
 * paid in — that reports a holding one million times too small, and because the
 * dollar figure is balance x price, it invents that too. Nothing in the response
 * distinguished it from a balance we read correctly.
 *
 * The house rule this project keeps arriving at: a reading we could not take is
 * never answered as a fact. A missing scale has no approximate answer, so the
 * amount goes null, the raw integer comes along for a caller who knows the
 * token, and the headline total says it is a floor.
 */
const src = (p: string) => readFileSync(new URL(`../src/lib/${p}`, import.meta.url), "utf8");
/** Comments name the defect on purpose, so assertions about it read code only. */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("a balance we cannot scale is not reported as a number", () => {
  it("alchemy — the sold endpoint — no longer defaults decimals to 18", () => {
    const s = src("alchemy.ts");
    expect(s, "the guess is gone").not.toMatch(/functionName: "decimals".*\n.*\? Number\(dRes\.result\) : 18/);
    expect(s).toMatch(/dRes\?\.status === "success" \? Number\(dRes\.result\) : null/);
    expect(s, "an unscalable holding reports null, not 0").toMatch(/balance: bal === null \? null/);
    expect(s, "and hands back the unscaled integer").toMatch(/balanceRaw/);
    expect(s, "and says why").toMatch(/decimalsUnknown: true/);
  });

  it("alchemy does not price a balance it could not scale", () => {
    // usdValue = balance x price. With no balance there is no product, and
    // multiplying a fabricated balance was how the wrong dollar figure got out.
    const s = src("alchemy.ts");
    expect(s).toMatch(/const usdValue = bal !== null && price !== undefined/);
  });

  it("alchemy keeps the unscalable holding instead of filtering it away as dust", () => {
    // Dropping it understates the wallet just as quietly as mis-scaling it.
    const s = src("alchemy.ts");
    expect(s).toMatch(/\.filter\(\(h\) => h\.balance === null \|\| parseFloat\(h\.balance\) > 1e-9\)/);
  });

  it("alchemy marks the total as a floor when anything is missing from it", () => {
    const s = src("alchemy.ts");
    expect(s).toMatch(/totalUsdComplete: unvalued === 0/);
    expect(s).toMatch(/holdingsWithUnknownDecimals/);
  });

  it("covalent's two mapping sites go through one honest formatter", () => {
    const s = code("covalent.ts");
    expect(s, "no contract_decimals fallback survives").not.toMatch(/contract_decimals \?\? 18/);
    expect(s).toMatch(/function amountOf\(/);
    // Both the balances path and the transfers path.
    expect(s).toMatch(/amountOf\(i\.balance, i\.contract_decimals\)/);
    expect(s).toMatch(/amountOf\(t\.delta, t\.contract_decimals\)/);
  });

  it("covalent's formatter rejects a scale that is not a real decimals value", () => {
    const s = src("covalent.ts");
    const fn = s.slice(s.indexOf("function amountOf("), s.indexOf("export async function walletNetworth"));
    expect(fn, "non-integer / negative / absurd scales are not trusted").toMatch(/Number\.isInteger\(decimals\)/);
    expect(fn).toMatch(/decimals < 0 \|\| decimals > 36/);
    // Zero decimals is legitimate — whole-unit tokens exist — and must survive.
    expect(fn, "0 must not be treated as missing").not.toMatch(/!decimals/);
  });
});
