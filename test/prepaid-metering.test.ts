import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isCreditTokenShape, creditHandle } from "@/lib/credits";

/**
 * A customer who prepaid must not be metered like an anonymous scraper.
 *
 * The per-IP cap exists because an unpaid call fans out to RPC, GoPlus and
 * DexScreener before payment is validated — an anonymous caller has to be
 * bounded before it reaches any of that. A prepaid caller is in a different
 * position entirely: the debit is atomic and happens BEFORE the handler, so a
 * token with no balance gets a 402 and touches no upstream at all. The balance
 * is already the limit, and it is one we were paid for.
 *
 * Metering them by IP broke the only thing this rail was sold on. The listing
 * says it is built for agents firing many checks a minute and the module header
 * sizes that at 200/minute; the cap was 60/minute, applied before the credit
 * path. Found on 2026-09-14 while spending a real $1 pack: the test was rate-
 * limited off the very service it had just paid for.
 */

const route = readFileSync("src/app/api/x402/[service]/route.ts", "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = strip(route);

describe("prepaid callers are metered by token, not by address", () => {
  it("keys the limiter on the credit token when one is presented", () => {
    expect(code).toMatch(/rateLimitKv\(\s*`x402:ck:\$\{creditHandle\(/);
  });

  it("still meters everything unpaid by IP", () => {
    expect(code).toMatch(/rateLimitKv\(\s*`x402:\$\{clientIp\(req\)\}`\s*,\s*60\s*,\s*60\s*\)/);
  });

  it("gives the prepaid path a ceiling above the 200/min the rail advertises", () => {
    const m = code.match(/const PREPAID_PER_MINUTE\s*=\s*(\d+)/);
    expect(m, "the prepaid ceiling must be a named constant, not a literal").toBeTruthy();
    const limit = Number(m![1]);
    expect(limit, "below what we sell is the bug this replaced").toBeGreaterThan(200);
    // Still a ceiling: a runaway client should burn its own balance, not our
    // upstream quotas.
    expect(limit).toBeLessThanOrEqual(1200);
  });

  /**
   * Hashed, for two reasons that both matter: a rate-limit key is not a place to
   * put a spendable bearer value, and an unhashed key would let one pack be
   * split across machines to multiply its own ceiling.
   */
  it("never puts the raw token in the limiter key", () => {
    expect(code).not.toMatch(/x402:ck:\$\{presented\}/);
    const token = `ck_${"a".repeat(36)}`;
    expect(creditHandle(token)).toMatch(/^[0-9a-f]{24}$/);
    expect(creditHandle(token)).not.toContain(token);
  });

  it("sends a malformed token down the IP path, where anything unpaid belongs", () => {
    expect(isCreditTokenShape("ck_" + "a".repeat(36))).toBe(true);
    expect(isCreditTokenShape("not-a-token")).toBe(false);
    expect(isCreditTokenShape("")).toBe(false);
    // Upper-case hex is not what we mint; treat it as unpaid rather than as a
    // second identity for the same balance.
    expect(isCreditTokenShape("ck_" + "A".repeat(36))).toBe(false);
  });

  it("decides how to meter before it spends a KV round trip on the token", () => {
    const rlAt = code.indexOf("rateLimitKv");
    const debitAt = code.indexOf("debitCredit(");
    expect(rlAt).toBeGreaterThan(0);
    expect(debitAt).toBeGreaterThan(rlAt);
  });
});
