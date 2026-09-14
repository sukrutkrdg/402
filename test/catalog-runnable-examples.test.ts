import { describe, it, expect } from "vitest";
import { SERVICES } from "@/lib/services";
import { exampleInputFor } from "@/lib/discovery-examples";

/**
 * Can an agent build a working call from what we publish?
 *
 * `/api/catalog` is the machine-readable front door — `/.well-known/x402`,
 * `/.well-known/x402.json` and `/.well-known/x402-bazaar.json` all rewrite to
 * it — so for most agents it is the only description of us they will ever read.
 * It published `p.placeholder`, which is UI copy written for a human looking at
 * an input box: `"0x… token address"`, `"0x… wallet"`, `"0x095ea7b3…"`.
 *
 * Measured on 2026-09-14 by buying a real $1 credit pack and trying to spend it
 * using nothing but the catalogue: 107 of 159 required parameters carried a
 * value no agent could send. Every call built from one came back
 * `400 Provide a valid 0x… address`. An agent has no reason to try twice.
 *
 * The values existed the whole time — `exampleInputFor` derives them from each
 * parameter's label and the keepalive settles against them every day. Its own
 * header documents this exact defect and fixes it for the discovery payload and
 * the 402 body. This surface was simply never wired to it.
 */

const PLACEHOLDER = /[…]/;

/** The shape the catalogue route builds, kept in one place so the test and the
 *  route cannot drift apart silently. */
function catalogExamples(service: (typeof SERVICES)[number]) {
  const runnable = exampleInputFor(service) ?? {};
  return service.params.map((p) => ({
    name: p.name,
    required: Boolean(p.required),
    example: runnable[p.name] ?? p.placeholder ?? undefined,
  }));
}

describe("catalogue input examples are runnable", () => {
  it("prefers the derived example over the UI placeholder", () => {
    // token-info is one of the 107: its placeholder is an ellipsis, and
    // exampleInputFor knows a real Base token address for it.
    const svc = SERVICES.find((s) => s.id === "token-info")!;
    const addr = catalogExamples(svc).find((p) => p.name === "address")!;
    expect(addr.example, "an ellipsis is not a value an agent can send").not.toMatch(PLACEHOLDER);
    expect(addr.example).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("leaves no required parameter advertising an ellipsis", () => {
    const bad: string[] = [];
    for (const s of SERVICES.filter((x) => !x.hidden)) {
      for (const p of catalogExamples(s)) {
        if (!p.required) continue;
        if (p.example === undefined || PLACEHOLDER.test(String(p.example))) bad.push(`${s.id}.${p.name}`);
      }
    }
    expect(bad, `these still publish an unusable example:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  /**
   * The placeholder is still the fallback, and that is deliberate: for a
   * parameter we hold no real value for, a shape beats nothing. This pins that
   * the fallback exists rather than having been deleted along with the bug.
   */
  it("keeps the placeholder as a fallback where no real value is known", () => {
    const svc = SERVICES.find((s) => (exampleInputFor(s) ?? {}) && s.params.length > 0)!;
    expect(catalogExamples(svc).length).toBe(svc.params.length);
  });
});
