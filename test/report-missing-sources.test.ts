import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A required field with no data behind it is an instruction to make something up.
 *
 * The B20 dossier gathers six reads, turns any failure into null, and then hands
 * the model a schema where `enforcementHistory`, `dilutionRisk` and
 * `metadataRisk` are all REQUIRED — under a prompt asking for "one crisp
 * factual sentence each from the data". When the supply read fails there is no
 * data, and the model cannot decline: the schema forbids an empty answer. So it
 * writes a plausible sentence about dilution for a token whose supply it never
 * saw, the report validates, and at $0.75 nothing in the response says which
 * sentences were evidence and which were inference.
 *
 * deep-dd has the same 1:1 mapping through `liquidityAssessment` and
 * `holderAssessment`.
 *
 * The rule the rest of this codebase already follows: an unread check is not a
 * passed check. It cannot be a positive, and it must not raise confidence.
 */
const src = readFileSync(new URL("../src/lib/ai-report.ts", import.meta.url), "utf8");
const bodyOf = (fn: string) => {
  const start = src.indexOf(`export async function ${fn}`);
  const next = src.indexOf("\nexport async function ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
};

describe.each([
  ["b20Dossier", "the institutional B20 report"],
  ["aiDeepDueDiligence", "deep due diligence"],
])("%s tells the model what it could not read", (fn) => {
  const body = bodyOf(fn);

  it("collects the null sources instead of leaving them indistinguishable from empty ones", () => {
    expect(body).toMatch(/const unavailable = Object\.entries\(data\)/);
    expect(body).toMatch(/\.filter\(\(\[, v\]\) => v === null\)/);
  });

  it("puts that list in the facts the model actually receives", () => {
    expect(body).toMatch(/factsWithin\(\{ \.\.\.data, unavailable \}/);
  });

  it("instructs it to say so rather than infer, and never to score it as a pass", () => {
    expect(body, "must name the rule").toMatch(/MISSING DATA/);
    expect(body).toMatch(/Not available — the <source> read failed/);
    expect(body, "no inferring the gap from the other sources").toMatch(/[Dd]o not infer it from the other sources/);
    expect(body, "an unread check must not become a positive").toMatch(/positives/);
    expect(body).toMatch(/neutral/);
  });

  it("marks the response itself, so the buyer knows what they got", () => {
    // The caller decides what a partial report is worth — deciding that quietly
    // on their behalf is the whole defect.
    expect(body).toMatch(/degraded: unavailable\.length > 0/);
    expect(body).toMatch(/unavailableSources: unavailable/);
  });
});

describe("the B20 dossier says it in the note too", () => {
  it("spells out which reads failed and that the verdict is provisional", () => {
    const body = bodyOf("b20Dossier");
    expect(body).toMatch(/INCOMPLETE: \$\{unavailable\.join\(", "\)\}/);
    expect(body).toMatch(/provisional/i);
  });
});
