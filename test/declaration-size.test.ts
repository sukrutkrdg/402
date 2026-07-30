import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every endpoint whose `description` grew past ~500 characters stopped being
 * payable: the CDP facilitator rejected the payment at verify, in ~1s, before
 * our handler ever ran — no error naming the cause, and the same handler kept
 * working through the credit path. Five services sat unsellable for weeks on
 * this, and shortening the text is what brought each one back. Until the
 * facilitator documents (or lifts) the limit, a long description is a silent
 * outage, so it is worth failing the build over.
 *
 * Read from source rather than importing SERVICES: the module pulls in
 * server-only handlers, and this check only needs the declared text.
 */
const LIMIT = 500;

function declaredDescriptions(): Array<{ id: string; description: string }> {
  const src = readFileSync(new URL("../src/lib/services.ts", import.meta.url), "utf8");
  const out: Array<{ id: string; description: string }> = [];
  // Entries are written as `id: "x",` … `description:\n  "…",` in that order.
  const re = /\bid:\s*"([\w-]+)"[\s\S]*?\bdescription:\s*(?:\/\/[^\n]*\n\s*)*"((?:[^"\\]|\\.)*)"/g;
  for (const m of src.matchAll(re)) {
    out.push({ id: m[1], description: JSON.parse(`"${m[2]}"`) });
  }
  return out;
}

describe("service declarations stay payable", () => {
  it("finds the declarations it is supposed to police", () => {
    const found = declaredDescriptions();
    expect(found.length).toBeGreaterThan(100);
    expect(found.map((f) => f.id)).toContain("safe-check");
  });

  it("keeps every description under the size the facilitator will verify", () => {
    const tooLong = declaredDescriptions()
      .filter((s) => s.description.length >= LIMIT)
      .map((s) => `${s.id} (${s.description.length} chars)`);
    expect(tooLong, `these will silently stop settling on x402: ${tooLong.join(", ")}`).toEqual([]);
  });
});
