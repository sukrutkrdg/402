import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { withPaymentTerms } from "@/lib/challenge-terms";

/**
 * The 402 body carried the goods and not the price.
 *
 * `withX402` v2 puts the terms in `payment-required` and returns a bare body;
 * we then fill that body with a response sample, a free-call hint and the
 * prepaid-credit path. The result was a refusal that showed a buyer exactly what
 * they would get and nothing about what it cost — readable to a client that
 * parses the header, opaque to one that reads `accepts` out of the JSON. That
 * second kind gives up without sending anything we could count, which makes it
 * the one loss we cannot see in the logs.
 *
 * Scope, so nobody re-reads this as a growth lever: the best-performing operator
 * on this rail returns a COMPLETELY EMPTY 402 body and draws 232 unique payers a
 * month, while we draw one. Body shape is not why. This is free compatibility,
 * not a fix for demand — that question was measured separately.
 *
 * Reported by Cairn (cairn@cairnwake.com) 2026-09-04, verified against Tavily's
 * and Exa's live challenges before any code moved.
 */

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const hdr = (o: unknown, name = "payment-required") => new Headers({ [name]: b64(o) });

const TERMS = {
  x402Version: 2,
  error: "Payment required",
  accepts: [
    { scheme: "exact", network: "eip155:8453", amount: "2000", asset: "0x8335", payTo: "0x973a" },
    { scheme: "exact", network: "eip155:137", amount: "2000", asset: "0x3c49", payTo: "0x973a" },
  ],
};

describe("withPaymentTerms", () => {
  it("copies the decoded terms into a body that had none", () => {
    const body = withPaymentTerms({ sample: { note: "preview" } }, hdr(TERMS));
    expect(body.x402Version).toBe(2);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect((body.accepts as unknown[]).length).toBe(2);
    // Both legs survive: a client that reads only the body must still see that
    // Polygon is payable, or the second chain may as well not exist to it.
    expect((body.accepts as Array<{ network: string }>).map((a) => a.network)).toEqual([
      "eip155:8453",
      "eip155:137",
    ]);
  });

  it("leaves what the caller already put in the body alone", () => {
    expect(withPaymentTerms({ sample: { note: "mine" } }, hdr(TERMS)).sample).toEqual({ note: "mine" });
  });

  it("never overwrites a field the library itself populated", () => {
    // If withX402 starts filling the body, its version wins and this becomes a
    // no-op rather than a second source of truth for the price.
    const body = withPaymentTerms({ accepts: ["library's own"] }, hdr(TERMS));
    expect(body.accepts).toEqual(["library's own"]);
  });

  it("reads the x- spelling too, for the same reason the route rewrites both", () => {
    expect(withPaymentTerms({}, hdr(TERMS, "x-payment-required")).x402Version).toBe(2);
  });

  it("returns the body untouched when there is no header", () => {
    const body = { sample: 1 };
    expect(withPaymentTerms(body, new Headers())).toBe(body);
    expect(Object.keys(body)).toEqual(["sample"]);
  });

  it("survives a header it cannot decode, rather than costing the caller the challenge", () => {
    for (const bad of ["not-base64!!", Buffer.from("{ broken", "utf8").toString("base64"), b64("a string"), b64([1, 2])]) {
      const body = withPaymentTerms({ sample: 1 }, new Headers({ "payment-required": bad }));
      expect(body).toEqual({ sample: 1 });
    }
  });
});

describe("the challenge path actually calls it", () => {
  const src = readFileSync(new URL("../src/app/api/x402/[service]/route.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("merges the terms before the body is returned as a 402", () => {
    expect(code).toMatch(/withPaymentTerms\(body, res\.headers\)/);
    expect(code.indexOf("withPaymentTerms(body, res.headers)")).toBeLessThan(
      code.indexOf("return NextResponse.json(body, { status: 402"),
    );
  });

  it("decodes in one place, not inline in the enrichment block", () => {
    // The route decodes base64 elsewhere too — fixRouteTemplate reads the
    // discovery declaration header — so the check is scoped to the block that
    // builds the challenge body. A second decoder there is how the price came to
    // disagree with itself once already (see price-rails.test.ts).
    const block = code.slice(
      code.indexOf("if (res.status === 402)"),
      code.indexOf("return NextResponse.json(body, { status: 402"),
    );
    expect(block.length, "the enrichment block was not found").toBeGreaterThan(200);
    expect(block, "no hand-rolled decode beside the helper").not.toMatch(/Buffer\.from\(/);
  });
});
