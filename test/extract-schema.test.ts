import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The extraction schema used to be built from the caller's `fields`, which made
 * it novel on almost every call — callers rarely ask for the same field set
 * twice — and a novel schema costs seconds. Measured on identical input:
 *
 *   schema just seen          2.15 s
 *   fresh, two fields         3.46 s
 *   fresh, three fields       5.35 s
 *   fresh, four fields        5.45 s
 *
 * A trust-leaderboard probe clocked the endpoint at 10.9 s. With the fields
 * moved into the prompt and one fixed pair-list schema, the same novel-field
 * calls run in 1.6–2.2 s.
 *
 * What must not drift is the response: callers have always received an object
 * keyed by their own field names, and that is now produced by our mapping rather
 * than by the model.
 */
const src = readFileSync(new URL("../src/lib/ai.ts", import.meta.url), "utf8");

describe("extraction uses one schema for every caller", () => {
  it("never builds a schema out of the caller's fields", () => {
    // The exact construction that made every call novel.
    expect(src).not.toMatch(/properties: Object\.fromEntries\(fields\.map/);
    expect(src).toMatch(/const EXTRACT_SCHEMA = \{/);
    expect(src).toMatch(/output_config: \{ format: \{ type: "json_schema", schema: EXTRACT_SCHEMA \} \}/);
  });

  it("puts the field list in the prompt instead", () => {
    expect(src).toMatch(/The fields to extract, in this exact order, are: \$\{fields\.join\(", "\)\}/);
  });

  it("both extract endpoints share the fixed pair shape", () => {
    // aiExtractBatch had the identical defect and the identical fix.
    const batch = src.slice(src.indexOf("export async function aiExtractBatch"));
    expect(batch).toMatch(/properties: \{ pairs: PAIRS \}/);
    expect(batch).not.toMatch(/Object\.fromEntries\(fields\.map/);
  });

  it("maps pairs back onto the caller's own field names and order", () => {
    // A model that renames, reorders or omits a field must not change the shape
    // of what we return — that is the caller's contract, not the model's.
    const fn = src.slice(src.indexOf("function toRecord"), src.indexOf("export async function aiExtract("));
    expect(fn).toMatch(/fields\.map\(\(f\) => \[f, byName\.get\(f\.toLowerCase\(\)\) \?\? ""\]\)/);
    expect(fn, "matching must survive a case difference from the model").toMatch(/toLowerCase\(\)/);
  });
});
