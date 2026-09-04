import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * An error log that fires on correct behaviour stops being read.
 *
 * On 2026-09-04 the route started logging every handler failure, and that change
 * immediately paid for itself — it produced the exact text behind two endpoints
 * that had been dead for a month, which Cloudflare had been hiding by replacing
 * the body of every 5xx with its own gateway page.
 *
 * Within hours it also filled the Vercel dashboard with red. Twenty of the
 * twenty-three error-level entries in one window were `lp-lock` answering "No LP
 * data for this token" to a bot probing tokens with no DEX pool — which is the
 * endpoint working exactly as designed, mapped to a 400, with nobody charged.
 * The operator's first read of the dashboard was "the site is throwing errors".
 *
 * So the level follows the status the route already computed: a 5xx is ours and
 * is an error, a 400 is the caller's input and is a warning. `--level error` has
 * to keep meaning "something is wrong with us", or the next real fault arrives
 * into a feed nobody trusts — the same way a daily alert becomes a filter rule.
 */
const src = readFileSync(new URL("../src/app/api/x402/[service]/route.ts", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const start = code.indexOf("function handlerErrorResponse(");
const fn = code.slice(start, start + 2000);

describe("handler failures are logged at the level they deserve", () => {
  it("computes the status before deciding how loudly to complain", () => {
    expect(fn.indexOf("const status ="), "status must be known first").toBeLessThan(fn.indexOf("console.error"));
  });

  it("logs a 5xx as an error, with the stack", () => {
    expect(fn).toMatch(/if \(status >= 500\) console\.error\(line, stack\)/);
  });

  it("logs a 4xx as a warning instead — it is the caller's input, not our fault", () => {
    expect(fn).toMatch(/else console\.warn\(line\)/);
    // No stack on the caller path: it describes our code, and our code is fine.
    expect(fn).not.toMatch(/console\.warn\(line, stack\)/);
  });

  it("still says which service failed and why, on both paths", () => {
    expect(fn).toMatch(/\[x402 handler-fail\] \$\{serviceId\}: \$\{message\}/);
  });

  it("keeps a single log site, so the two levels cannot drift apart", () => {
    const errors = fn.match(/console\.error\(/g) ?? [];
    const warns = fn.match(/console\.warn\(/g) ?? [];
    expect(errors).toHaveLength(1);
    expect(warns).toHaveLength(1);
  });

  it("leaves the caller's status mapping untouched — only the logging changed", () => {
    // The 400 branch is what makes "no LP data" a caller error in the first
    // place; if it ever became a 500 the log level would follow it wrongly.
    expect(fn).toMatch(/no \.\*data/);
    expect(fn).toMatch(/\? 400/);
    expect(fn).toMatch(/\? 502/);
  });
});
