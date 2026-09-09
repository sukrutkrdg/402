import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SERVICES } from "@/lib/services";

/**
 * The quickstart must not promise something the catalogue denies.
 *
 * On 2026-09-09 an outside reader diffed /agents against /api/catalog and found
 * two claims that did not survive the comparison: the page said "every service
 * serves one free call a day" when 53 of 143 qualify, and it demonstrated the
 * free tier with `token-risk`, which publishes `freeTier: false`. So the first
 * command a developer copied returned a 402 instead of the promised free
 * result — on the page whose whole job is the first five minutes.
 *
 * Nothing in the suite compared the two surfaces, which is why a stranger found
 * it first. These tests are that comparison.
 */

const source = readFileSync("src/app/agents/page.tsx", "utf8");

/**
 * Comments stripped before matching. The header above quotes the wording it
 * exists to prevent, so a naive search finds the retired claim inside the note
 * explaining why it was retired — and the guard fails on the record of its own
 * fix. What matters is what the page renders.
 */
const page = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The rule /api/catalog publishes as `freeTier`. Kept identical on purpose. */
const hasFreeTier = (s: (typeof SERVICES)[number]) => s.category !== "AI" && !s.noFreeTier;

describe("the free-tier example is actually free-tier", () => {
  it("derives the example instead of hardcoding one that can drift", () => {
    expect(source).toMatch(/const freeExample =/);
    expect(page).toMatch(/s\.category !== "AI" && !s\.noFreeTier/);
  });

  it("resolves to a service the catalogue marks freeTier:true", () => {
    const chosen = SERVICES.find((s) => !s.hidden && hasFreeTier(s) && s.params.length > 0);
    expect(chosen).toBeDefined();
    expect(hasFreeTier(chosen!)).toBe(true);
  });

  it("shows the opt-in flag, without which the call returns 402 instead", () => {
    // The free tier is off by default so an unpaid probe sees the price, not an
    // answer. An example that omits the flag documents a call that cannot work.
    expect(page).toMatch(/&free=1/);
    expect(page).toMatch(/x-402-free: 1/);
  });
});

describe("what the page claims about coverage", () => {
  it("does not claim every service has a free tier", () => {
    expect(page).not.toMatch(/every service\s+serves one free call/);
    expect(page).not.toMatch(/1 free call per service per day \(no wallet\)/);
  });

  it("states a count that matches the catalogue rule", () => {
    // Derived and rendered, never typed in: a hardcoded number here is the same
    // bug one step later.
    expect(page).toMatch(/const freeTierCount = SERVICES\.filter/);
    expect(page).toMatch(/\{freeTierCount\}/);
    expect(page).not.toMatch(/\b53 of them\b/);
  });

  it("says the paid example is paid, since it is used right below the free one", () => {
    expect(page).toMatch(/token-risk<\/code>, which has no free tier/);
  });
});

describe("the catalogue still has something to demonstrate", () => {
  /**
   * Guards the other direction: if every free tier were ever switched off, the
   * page would silently fall back to a paid example and start lying again.
   */
  it("has at least one non-AI service with a free tier and a parameter", () => {
    const usable = SERVICES.filter((s) => !s.hidden && hasFreeTier(s) && s.params.length > 0);
    expect(usable.length).toBeGreaterThan(0);
  });

  it("keeps token-risk out of the free tier, which is what the copy now says", () => {
    const tr = SERVICES.find((s) => s.id === "token-risk");
    expect(tr).toBeDefined();
    expect(hasFreeTier(tr!)).toBe(false);
  });
});
