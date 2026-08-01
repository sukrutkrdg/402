import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Read the catalogue from source rather than importing SERVICES: the module
 * pulls in server-only handlers. This test only needs the declared ids, prices
 * and hidden flags, which is exactly what the suggestions must stay true to —
 * a suggestion carrying a stale price is a lie the buyer acts on.
 */
function catalogue(): Map<string, { price: string; hidden: boolean }> {
  const src = readFileSync(new URL("../src/lib/services.ts", import.meta.url), "utf8");
  const out = new Map<string, { price: string; hidden: boolean }>();
  for (const chunk of src.split(/\n {2}\{\n/).slice(1)) {
    const body = chunk.split(/\n {2}\},?\n/)[0];
    const id = body.match(/^\s*id:\s*"([\w-]+)",/m)?.[1];
    const price = body.match(/^\s*price:\s*"([^"]+)",/m)?.[1];
    if (!id || !price) continue;
    // Only an unconditional `hidden: true` is a static error. Services gated on
    // configuration (`hidden: !s3Config()`) are visible whenever that config is
    // present, and relatedFor filters the catalogue at request time anyway — so
    // suggesting one is safe: it simply drops out when the bucket is absent.
    out.set(id, { price, hidden: /^\s*hidden:\s*true/m.test(body) });
  }
  return out;
}

/** The curated pairs, read from source so the test cannot drift from the map. */
function pairs(): Record<string, string[]> {
  const src = readFileSync(new URL("../src/lib/related.ts", import.meta.url), "utf8");
  const block = src.split("const PAIRS: Record<string, string[]> = {")[1].split("};")[0];
  const out: Record<string, string[]> = {};
  for (const m of block.matchAll(/"([\w-]+)":\s*\[([^\]]+)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/"([\w-]+)"/g)].map((x) => x[1]);
  }
  return out;
}

describe("related suggestions point at things that exist", () => {
  it("every curated pair names a real, visible service", () => {
    const cat = catalogue();
    const bad: string[] = [];
    for (const [from, tos] of Object.entries(pairs())) {
      if (!cat.has(from)) bad.push(`source ${from} does not exist`);
      for (const to of tos) {
        if (!cat.has(to)) bad.push(`${from} → ${to} does not exist`);
        else if (cat.get(to)!.hidden) bad.push(`${from} → ${to} is hidden`);
        if (to === from) bad.push(`${from} suggests itself`);
      }
    }
    expect(bad, bad.join("; ")).toEqual([]);
  });

  it("the output-side services it always falls back to are real and sellable", () => {
    const src = readFileSync(new URL("../src/lib/related.ts", import.meta.url), "utf8");
    const ids = [...src.split("const OUTPUT_SIDE = [")[1].split("]")[0].matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
    const cat = catalogue();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(cat.has(id), `${id} is not in the catalogue`).toBe(true);
  });

  it("never suggests anything for the services whose response is a credential", () => {
    const src = readFileSync(new URL("../src/lib/related.ts", import.meta.url), "utf8");
    const guarded = [...src.split("const NO_SUGGESTIONS = new Set([")[1].split("]")[0].matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
    // buy-credits hands back a bearer token; padding that response with an advert
    // is the last thing a buyer wants to parse.
    expect(guarded).toContain("buy-credits");
    expect(guarded).toContain("secure-token");
  });

  it("prices are never written into the suggestion map", () => {
    const src = readFileSync(new URL("../src/lib/related.ts", import.meta.url), "utf8");
    const map = src.split("const PAIRS")[1].split("};")[0];
    expect(map).not.toMatch(/\$\d/);
  });
});
