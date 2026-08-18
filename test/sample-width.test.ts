import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The shop window is what an agent reads before paying, and it had grown to
 * sixteen fields on some endpoints — the verdict buried among a dozen
 * `somethingCount` entries.
 *
 * There is a second, unproven reason to cap it. Fourteen of our listings settle
 * payments and stay out of the discovery index, and they skew systematically
 * large: 2,816 against 2,592 bytes of declaration and 9.3 against 6.0 sample
 * keys, with the widest samples the ones absent. Paying them changed nothing, a
 * per-seller ceiling is ruled out (one seller carries 965 records to our 119),
 * and the scan is stable. Size is the remaining candidate; this cap is the
 * cheapest test of it, and it stands on the readability argument regardless.
 */
const src = readFileSync(new URL("../src/lib/sample-cache.ts", import.meta.url), "utf8");

describe("shop-window samples stay narrow", () => {
  it("caps how many fields a sample carries", () => {
    const cap = Number(src.match(/MAX_SAMPLE_KEYS = (\d+)/)?.[1]);
    expect(cap).toBeGreaterThan(3);
    expect(cap).toBeLessThanOrEqual(10);
    expect(src, "the cap must be applied on the write path").toMatch(/headline\(sanitize\(toPreview\(data\)\)\)/);
  });

  it("keeps the answer and drops the counting", () => {
    // Order matters more than the cap: truncating alphabetically would throw
    // away `verdict` and keep `announcementsCount`.
    const ranking = src.slice(src.indexOf("function headline"), src.indexOf("export async function saveSample"));
    const headlineIdx = ranking.indexOf("HEADLINE.test(k))");
    const countIdx = ranking.lastIndexOf("/Count$/.test(k))");
    expect(headlineIdx).toBeGreaterThan(-1);
    expect(countIdx).toBeGreaterThan(headlineIdx);
    for (const k of ["verdict", "riskLevel", "score", "degraded"]) {
      expect(new RegExp(src.match(/const HEADLINE = (\/.*\/)/)![1].slice(1, -1)).test(k), `${k} must rank first`).toBe(true);
    }
  });

  it("leaves a sample that is already narrow untouched", () => {
    // A cap that rewrites small samples would churn every listing for nothing.
    expect(src).toMatch(/if \(entries\.length <= MAX_SAMPLE_KEYS\) return preview;/);
  });
});
