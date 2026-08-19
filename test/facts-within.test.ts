import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { factsWithin } from "@/lib/ai-report";

/**
 * The evidence handed to the model has to be parseable evidence.
 *
 * Every report bounded its payload with `JSON.stringify(data).slice(0, N)`,
 * which cuts wherever N lands — mid-key, mid-number, mid-escape. The model then
 * writes a confident verdict out of whatever survived the cut, the schema
 * validates, the response looks entirely normal, and the buyer has no way to
 * know that half the facts were malformed. It is the same failure this codebase
 * keeps finding: a wrong answer wearing the shape of a right one.
 *
 * Length comes from lists — holders, transactions, trending tokens — so lists
 * are what shrinks, and a dropped item leaves a note so the model is told it is
 * seeing a sample rather than left to assume it saw everything.
 */
const big = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `0x${String(i).padStart(40, "0")}`, pct: i / 100 }));

describe("factsWithin", () => {
  it("leaves small payloads exactly as they were", () => {
    const data = { risk: { score: 12 }, price: { usd: 1.5 } };
    expect(factsWithin(data, 6000)).toBe(JSON.stringify(data));
  });

  it("always returns parseable JSON, however hard it has to cut", () => {
    for (const limit of [4000, 2000, 800, 300, 120, 60, 20]) {
      const out = factsWithin({ holders: big(500), risk: { score: 40 }, note: "x".repeat(200) }, limit);
      expect(() => JSON.parse(out), `limit ${limit} produced unparseable JSON`).not.toThrow();
    }
  });

  it("respects the limit", () => {
    const out = factsWithin({ holders: big(500) }, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
  });

  it("keeps the scalars and shortens the lists, not the other way round", () => {
    // The verdict hangs on the scalars; the list is supporting detail.
    const out = JSON.parse(factsWithin({ risk: { score: 87, flags: ["honeypot"] }, holders: big(400) }, 900));
    expect(out.risk.score, "the headline fact must survive").toBe(87);
    expect(out.holders.length).toBeLessThan(400);
  });

  it("says where items were dropped instead of letting the model assume it saw them all", () => {
    const out = JSON.parse(factsWithin({ holders: big(400) }, 900)) as { holders: unknown[] };
    expect(String(out.holders.at(-1))).toMatch(/more omitted/);
  });

  it("shortens nested lists too", () => {
    const out = JSON.parse(factsWithin({ a: { b: { c: big(300) } } }, 700)) as { a: { b: { c: unknown[] } } };
    expect(out.a.b.c.length).toBeLessThan(300);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("degrades to an honest note when even the scalars do not fit", () => {
    const out = JSON.parse(factsWithin({ blob: "x".repeat(5000) }, 100)) as { note?: string };
    expect(out.note).toMatch(/omitted/i);
  });

  it("handles the empty and null cases without producing the string 'undefined'", () => {
    expect(JSON.parse(factsWithin({}, 100))).toEqual({});
    expect(factsWithin(undefined, 100)).toBe("null");
  });
});

describe("no report bounds its facts by slicing the serialized string", () => {
  it("the old pattern is gone from every call site", () => {
    const src = readFileSync(new URL("../src/lib/ai-report.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/JSON\.stringify\([^)]*\)\.slice\(0,/);
    // Seven payloads go through the one helper.
    expect(code.match(/factsWithin\(/g)?.length ?? 0).toBeGreaterThanOrEqual(8); // 7 uses + the definition
  });
});
