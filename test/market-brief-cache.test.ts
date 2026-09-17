import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A market brief is the same answer for everybody, and it is slow to make.
 *
 * `ai-market-brief` takes no parameters: every caller asks the identical
 * question and the answer summarises the whole Base token market. Measured on
 * 2026-09-17 across four paid calls it took 9.7s, 10.8s, 16.1s and 19.5s end to
 * end — about 2.5s of that is x402 settlement and under a second is the two
 * upstream fetches, so the rest is one Claude call. A second call immediately
 * after the first was no faster, so it is the model's own variance rather than
 * a cold start.
 *
 * That matters beyond impatience: an agent with a default 10-second client
 * timeout can pay and then abandon the request, and we would never see it —
 * the settlement lands, the response goes nowhere.
 *
 * So one generation serves everyone inside a short window, and the response
 * always declares how old it is. Nothing here is allowed to present a cached
 * brief as a fresh one.
 */
const src = readFileSync("src/lib/ai-report.ts", "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = strip(src);

describe("ai-market-brief cache", () => {
  it("keeps the window short against what it summarises", () => {
    const m = code.match(/const BRIEF_TTL_SECONDS\s*=\s*(\d+)/);
    expect(m, "the window must be a named constant").toBeTruthy();
    const ttl = Number(m![1]);
    // Long enough that a burst pays for one generation; short against trending
    // and newly-listed tokens, which move over hours.
    expect(ttl).toBeGreaterThanOrEqual(120);
    expect(ttl).toBeLessThanOrEqual(1800);
  });

  it("always declares whether the answer was cached and how old it is", () => {
    expect(code).toMatch(/cached:\s*true,\s*ageSeconds/);
    expect(code).toMatch(/cached:\s*false,\s*\n?\s*ageSeconds:\s*0/);
  });

  it("refuses to serve a brief whose age it cannot establish", () => {
    // An unparseable timestamp yields NaN, which must not read as "age zero".
    expect(code).toMatch(/Number\.isFinite\(ageSeconds\)/);
    expect(code).toMatch(/brief\.mood &&/);
  });

  it("never lets a cache failure cost the caller their answer", () => {
    // Both the read and the write are inside try/catch: the paid path must
    // survive KV being unreachable, in either direction.
    const readGuard = code.indexOf("kvGet(BRIEF_KEY)");
    const writeGuard = code.indexOf("kvSet(BRIEF_KEY");
    expect(readGuard).toBeGreaterThan(0);
    expect(writeGuard).toBeGreaterThan(readGuard);
    expect(code.slice(readGuard - 200, readGuard)).toMatch(/try\s*\{/);
    expect(code.slice(writeGuard - 200, writeGuard)).toMatch(/try\s*\{/);
  });

  it("caches only the brief, not the per-request envelope", () => {
    // `checkedAt` is when THIS request was answered; storing it would make
    // every cached response claim to have been checked when it was generated.
    const stored = code.match(/const brief = \{[\s\S]*?\n  \};/);
    expect(stored, "the stored object must be a named value, not an inline spread").toBeTruthy();
    expect(stored![0]).not.toMatch(/checkedAt/);
    expect(stored![0]).toMatch(/generatedAt,/);
  });
});
