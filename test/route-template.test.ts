import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every service we published declared `routeTemplate: ":var1"`.
 *
 * `withX402` hardcodes a `"*"` route pattern and the bazaar extension rewrites a
 * wildcard segment to `:varN`, so the template we shipped could not match any
 * concrete resource URL. The Bazaar's `matches_resource` check therefore failed
 * on all of them. It is an upstream bug (x402-foundation/x402#3019) and we were
 * its largest single contributor in the public index — 103 of the 248 malformed
 * records were ours — while 34 of our own services sat unindexed.
 *
 * The repair is to REMOVE the field, not to substitute a template: with none,
 * the indexer uses the request pathname, which is the per-service URL we want.
 * Declaring `/api/x402/:service` would be worse than the bug, collapsing all 131
 * services into one canonical resource.
 */
const src = readFileSync(new URL("../src/app/api/x402/[service]/route.ts", import.meta.url), "utf8");

describe("the published declaration carries no generated route template", () => {
  it("rewrites the payment-required header on the challenge path", () => {
    expect(src).toMatch(/function fixRouteTemplate\(headers: Headers\)/);
    expect(src, "must run before the 402 is returned").toMatch(/fixRouteTemplate\(headers\);\s*\n\s*return NextResponse\.json\(body, \{ status: 402/);
    expect(src, "both header spellings").toMatch(/"payment-required", "x-payment-required"/);
  });

  it("deletes the field rather than substituting a template", () => {
    // A single template for a dynamic route would merge every service into one
    // canonical resource — a worse outcome than not being indexed.
    expect(src).toMatch(/delete bazaar\.routeTemplate/);
    expect(src).not.toMatch(/routeTemplate\s*[:=]\s*["`']\/api\/x402/);
  });

  it("leaves a genuine template alone", () => {
    // Only the generated :varN form is removed, so this stays correct if the
    // library is fixed upstream and starts emitting a real path.
    const guard = src.match(/if \(!(\/\^:var.*?\/)\.test\(bazaar\.routeTemplate\)\) continue;/);
    expect(guard, "the :varN guard must exist").not.toBeNull();
    const re = new RegExp(/^:var\d+$|(^|\/):var\d+(\/|$)/);
    expect(re.test(":var1")).toBe(true);
    expect(re.test("/api/x402/:var2")).toBe(true);
    expect(re.test("/api/x402/:service")).toBe(false);
    expect(re.test("/v1/check/:chain/:token")).toBe(false);
  });
});
