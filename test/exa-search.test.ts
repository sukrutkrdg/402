import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { exaSearch, exaWantsText, exaConfigured } from "@/lib/exa";
import { SERVICES } from "@/lib/services";
import { staticOutputExample } from "@/lib/discovery-examples";

/**
 * The endpoint exists because of a naming result, so the naming is the part
 * under test.
 *
 * `web-search` sells the same capability at the same price on a comparable
 * upstream and has one payer in thirty days — us. Every Exa reseller in the
 * discovery index that draws real traffic carries `exa` in its resource path,
 * and the best of them outsells `api.exa.ai` roughly ten to one while charging
 * more. So `id: "exa-search"` is not a label, it is the mechanism: the id
 * becomes `/api/x402/exa-search`, and that path is what the index matches.
 * Renaming it to something tidier would quietly undo the whole change.
 *
 * The rest is margin arithmetic that a future edit could break without any
 * visible symptom. Exa bills $7/1k for a search of up to ten results, $1/1k per
 * result beyond ten, and $1/1k per page per content type. At the market's $0.01
 * only the first of those fits, which is why results are capped and why
 * highlights are a separate priced tier rather than a default.
 */

const ORIGINAL_KEY = process.env.EXA_API_KEY;
afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_KEY === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = ORIGINAL_KEY;
});

/** Capture the request body Exa would have received. */
function stubExa(response: unknown, status = 200) {
  const seen: { body: Record<string, unknown> | null; auth: string | null } = { body: null, auth: null };
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    seen.body = JSON.parse(String(init.body));
    seen.auth = new Headers(init.headers).get("authorization");
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    } as unknown as Response;
  });
  return seen;
}

const ONE_RESULT = {
  requestId: "req_1",
  searchTime: 412,
  results: [
    { id: "a", title: "Qdrant", url: "https://github.com/qdrant/qdrant", publishedDate: "2026-04-18T00:00:00.000Z", author: null, score: 0.74121 },
  ],
};

describe("the name is the mechanism", () => {
  const svc = SERVICES.find((s) => s.id === "exa-search");

  it("is registered under an id that puts the engine's name in the path", () => {
    expect(svc, "exa-search is missing from the catalog").toBeTruthy();
    // The route is /api/x402/[service], so the id IS the path segment.
    expect(svc!.id).toContain("exa");
  });

  it("is paid-only, because a 200 without a challenge is invisible to discovery", () => {
    // Proven twice in August 2026: flipping gas-oracle and ens-resolve to
    // paid-only put both in the index on the next payment after months of
    // nothing. A free tier here would cost us the listing this endpoint is for.
    expect(svc!.noFreeTier).toBe(true);
  });

  it("charges the price the market has already proven, not a discount", () => {
    expect(svc!.price).toBe("$0.01");
  });

  it("ships a shop window, since it has never run and has no captured sample", () => {
    const ex = staticOutputExample("exa-search");
    expect(ex, "a new row advertising no output reads as 'returns nothing'").toBeTruthy();
    // A search endpoint whose example shows a count where the results belong is
    // advertising the wrong thing.
    expect(Array.isArray(ex!.results)).toBe(true);
  });
});

describe("margin discipline", () => {
  beforeEach(() => {
    process.env.EXA_API_KEY = "k";
  });

  it("caps results at ten, where Exa's flat search price stops", async () => {
    // $7/1k covers ten results; each one after that adds $1/1k, which a flat
    // $0.01 sale cannot absorb.
    const seen = stubExa(ONE_RESULT);
    await exaSearch({ query: "x", numResults: "50" });
    expect(seen.body!.numResults).toBe(10);
  });

  it("caps harder when highlights are on, because each page bills again", async () => {
    const seen = stubExa(ONE_RESULT);
    await exaSearch({ query: "x", numResults: "50", text: "1" });
    expect(seen.body!.numResults).toBe(5);
    expect(seen.body!.contents).toEqual({ highlights: true });
  });

  it("never asks for contents in the entry tier", async () => {
    const seen = stubExa(ONE_RESULT);
    await exaSearch({ query: "x" });
    expect(seen.body!.contents).toBeUndefined();
  });

  it("refuses to sell the deep types, which cost more than any tier we charge", async () => {
    for (const type of ["deep", "deep-lite", "deep-reasoning"]) {
      const seen = stubExa(ONE_RESULT);
      await exaSearch({ query: "x", type });
      // Falls back rather than erroring: a caller who guesses a type name should
      // still get the search they paid for.
      expect(seen.body!.type, `${type} must not reach Exa`).toBe("auto");
    }
  });

  it("passes the cheap types through untouched", async () => {
    for (const type of ["auto", "fast", "instant"]) {
      const seen = stubExa(ONE_RESULT);
      await exaSearch({ query: "x", type });
      expect(seen.body!.type).toBe(type);
    }
  });
});

describe("the tier test lives in one place", () => {
  const route = readFileSync(new URL("../src/app/api/x402/[service]/route.ts", import.meta.url), "utf8");
  const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("reads true only for the affirmative spellings", () => {
    for (const yes of ["true", "1", "yes", "TRUE", " Yes "]) expect(exaWantsText(yes)).toBe(true);
    for (const no of ["", "false", "0", "no", "maybe"]) expect(exaWantsText(no)).toBe(false);
  });

  it("prices the tier inside the one shared function, so both rails see it", () => {
    const fn = code.slice(
      code.indexOf("async function effectivePriceFor("),
      code.indexOf("async function attachRetention"),
    );
    expect(fn).toMatch(/service\.id === "exa-search"/);
    expect(fn).toMatch(/exaWantsText\(/);
    expect(fn).toMatch(/\$0\.03/);
  });

  it("does not re-derive the tier anywhere else in the route", () => {
    const fn = code.slice(
      code.indexOf("async function effectivePriceFor("),
      code.indexOf("async function attachRetention"),
    );
    expect(code.replace(fn, "")).not.toMatch(/exaWantsText\(/);
  });
});

describe("nobody is charged for a call we could not serve", () => {
  it("throws before touching Exa when the key is missing", async () => {
    delete process.env.EXA_API_KEY;
    expect(exaConfigured()).toBe(false);
    const seen = stubExa(ONE_RESULT);
    await expect(exaSearch({ query: "x" })).rejects.toThrow(/EXA_API_KEY/);
    expect(seen.body, "no upstream call may be made").toBeNull();
  });

  it("throws on an empty query rather than buying an empty search", async () => {
    process.env.EXA_API_KEY = "k";
    const seen = stubExa(ONE_RESULT);
    await expect(exaSearch({ query: "   " })).rejects.toThrow(/query/i);
    expect(seen.body).toBeNull();
  });

  it("surfaces the upstream's own status, so we can tell whose fault it is", async () => {
    process.env.EXA_API_KEY = "k";
    stubExa({ error: "bad key" }, 401);
    // A 401 is our key to fix; a 400 would be the caller's query. A blanket
    // failure hides which, and handlerErrorResponse maps this to a 502 so no
    // settlement happens either way.
    await expect(exaSearch({ query: "x" })).rejects.toThrow(/401/);
  });
});

describe("the response shape is stable across both tiers", () => {
  it("returns highlights as null in the entry tier rather than omitting the field", async () => {
    process.env.EXA_API_KEY = "k";
    stubExa(ONE_RESULT);
    const out = (await exaSearch({ query: "x" })) as { results: Array<Record<string, unknown>>; highlightsIncluded: boolean };
    expect(out.highlightsIncluded).toBe(false);
    expect(out.results[0]).toHaveProperty("highlights", null);
    expect(out.results[0].score).toBe(0.7412);
  });

  it("settles on an empty result set — 'nothing matched' is a real answer", async () => {
    process.env.EXA_API_KEY = "k";
    stubExa({ results: [] });
    const out = (await exaSearch({ query: "x" })) as { resultCount: number };
    // Throwing here would make a legitimate served search free.
    expect(out.resultCount).toBe(0);
  });

  it("cleans domain input rather than forwarding whatever was typed", async () => {
    process.env.EXA_API_KEY = "k";
    const seen = stubExa(ONE_RESULT);
    await exaSearch({ query: "x", includeDomains: " https://arxiv.org/abs , github.com ,, " });
    expect(seen.body!.includeDomains).toEqual(["arxiv.org", "github.com"]);
  });
});
