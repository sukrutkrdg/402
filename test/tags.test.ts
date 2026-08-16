import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tagsFor } from "../src/lib/tags";

/**
 * Discovery tags used to be `[category, "x402", "base"]` for every listing, so
 * all 60 Onchain services carried the identical three words and nothing we sell
 * could be reached by searching for what it does. The endpoint leading our
 * category on distinct payers lists `honeypot check, honeypot detector, can i
 * sell token, token scam check, rug detection` — we listed `onchain`.
 */
function services(): { id: string; category: string }[] {
  const src = readFileSync(new URL("../src/lib/services.ts", import.meta.url), "utf8");
  const out: { id: string; category: string }[] = [];
  for (const chunk of src.split(/\r?\n {2}\{\r?\n/).slice(1)) {
    const body = chunk.split(/\r?\n {2}\},?\r?\n/)[0];
    const id = body.match(/^\s*id:\s*"([\w-]+)",/m)?.[1];
    const category = body.match(/^\s*category:\s*"([^"]+)"/m)?.[1];
    if (id && category && !/^\s*\/\//.test(body)) out.push({ id, category });
  }
  return out;
}

describe("tags describe what a service does", () => {
  it("gives the token-safety services the words buyers search", () => {
    // The exact vocabulary competitors in this category use.
    for (const [id, word] of [
      ["token-risk", "honeypot"],
      ["token-risk", "rug-check"],
      ["sellability", "can-i-sell"],
      ["contract-danger", "contract-risk"],
      ["pre-trade-gate", "pre-trade"],
      ["sanctions", "ofac"],
      ["sign-guard", "wallet-security"],
    ] as const) {
      expect(tagsFor({ id, category: "Onchain" }), `${id} must be findable by "${word}"`).toContain(word);
    }
  });

  it("no longer gives every service in a category the same tags", () => {
    const all = services();
    expect(all.length).toBeGreaterThan(100);
    const byCategory = new Map<string, Set<string>>();
    for (const s of all) {
      const key = `${s.category}::${tagsFor(s).join(",")}`;
      const set = byCategory.get(s.category) ?? new Set<string>();
      set.add(key);
      byCategory.set(s.category, set);
    }
    // Every category with more than one service must produce more than one tag set.
    for (const [cat, sets] of byCategory) {
      const n = all.filter((s) => s.category === cat).length;
      if (n > 1) expect(sets.size, `${cat}: ${n} services share one tag set`).toBeGreaterThan(1);
    }
  });

  it("always keeps the protocol and chain tags, and stays readable", () => {
    for (const s of services()) {
      const t = tagsFor(s);
      expect(t, `${s.id}`).toContain("x402");
      expect(t, `${s.id}`).toContain("base");
      expect(t.length, `${s.id} has ${t.length} tags`).toBeLessThanOrEqual(14);
      expect(new Set(t).size, `${s.id} has duplicate tags`).toBe(t.length);
      for (const tag of t) expect(tag, `${s.id}: "${tag}"`).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("falls back to the id for a service nobody listed", () => {
    // A service added later must never end up with only the generic words.
    const t = tagsFor({ id: "morpho-liquidatable", category: "Lending" });
    expect(t).toContain("liquidation");
    expect(t).toContain("morpho");
    expect(t.length).toBeGreaterThan(3);
  });
});
