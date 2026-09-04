import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { indexHealthProblems, type IndexHealth } from "@/lib/index-health";

/**
 * The check existed and nothing read it.
 *
 * `/api/index-health` could answer "can anyone still find us" for weeks, and on
 * 2026-09-04 `web-extract` was found absent from discovery only because someone
 * ran it by hand. That is the same shape as the Anthropic outage of 2026-08-20:
 * a correct detector that was never put on a schedule, so a real fault sat in
 * production until a call happened to fail.
 *
 * What this file guards is the judgement, not the plumbing — which non-zero
 * counts are worth waking someone for, and which are noise that would turn the
 * alert into a filter rule.
 */

const base: IndexHealth = {
  checkedAt: "2026-09-04T04:00:00.000Z",
  method: "discovery/search?payTo — one targeted query per service",
  queries: 142,
  catalog: 142,
  indexedSeen: 142,
  uncheckedCount: 0,
  degraded: false,
  missingCount: 0,
  stalePriceCount: 0,
  underQuotedCount: 0,
  staleNetworksCount: 0,
  expiringSoonCount: 0,
  serve: ["eip155:8453", "eip155:137"],
  reseedCount: 0,
  reseedCostUsd: 0,
  missing: [],
  stalePrice: [],
  staleNetworks: [],
  expiringSoon: [],
  wrongPayTo: [],
  orphansSeen: [],
  note: "",
};

describe("what counts as needing a person", () => {
  it("says nothing when the index agrees with the catalogue", () => {
    expect(indexHealthProblems(base)).toEqual([]);
  });

  it("raises a service no agent can find", () => {
    const p = indexHealthProblems({ ...base, missingCount: 1, missing: [{ id: "web-extract", price: "$0.01" }] });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/web-extract/);
    expect(p[0]).toMatch(/absent from discovery/i);
  });

  it("raises a price quoted BELOW what we charge, because that breaks purchases", () => {
    const p = indexHealthProblems({
      ...base,
      stalePriceCount: 1,
      underQuotedCount: 1,
      stalePrice: [{ id: "ai-translate", indexedUsd: 0.03, liveUsd: 0.08, lastUpdated: "", underQuoted: true }],
    });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/ai-translate/);
  });

  it("stays quiet about a price quoted ABOVE what we charge", () => {
    // The index asking for more than we charge does not stop a sale — the buyer
    // signs for more than needed and settlement succeeds. It self-corrects on
    // the next settlement, so it is reported by the route and not paged on.
    const p = indexHealthProblems({
      ...base,
      stalePriceCount: 1,
      underQuotedCount: 0,
      stalePrice: [{ id: "gas-oracle", indexedUsd: 0.05, liveUsd: 0.01, lastUpdated: "", underQuoted: false }],
    });
    expect(p).toEqual([]);
  });

  it("NEVER pages on staleNetworks, however large the backlog", () => {
    // 125 rows on 2026-09-04, because Polygon reaches the index one settlement
    // at a time and the keepalive drains it over three weeks. An alert that
    // fires every morning about a backlog already draining itself becomes a
    // filter rule, and then the next real alert is invisible too.
    expect(indexHealthProblems({ ...base, staleNetworksCount: 125 })).toEqual([]);
  });

  it("raises rows about to be evicted, and names the days left", () => {
    const p = indexHealthProblems({
      ...base,
      expiringSoonCount: 1,
      expiringSoon: [{ id: "b20-peg", lastCalledAt: "", evictsAt: "", daysLeft: 3 }],
    });
    expect(p[0]).toMatch(/b20-peg \(3d\)/);
  });

  it("raises a row advertising someone else's payTo", () => {
    const p = indexHealthProblems({ ...base, wrongPayTo: [{ id: "token-risk", indexedPayTo: "0xdead" }] });
    expect(p[0]).toMatch(/payTo that is not ours/);
  });

  it("reports every distinct problem rather than only the first", () => {
    const p = indexHealthProblems({
      ...base,
      missingCount: 1,
      missing: [{ id: "a", price: "$0.01" }],
      expiringSoonCount: 1,
      expiringSoon: [{ id: "b", lastCalledAt: "", evictsAt: "", daysLeft: 1 }],
    });
    expect(p).toHaveLength(2);
  });
});

describe("the cron refuses to conclude from a partial read", () => {
  const src = readFileSync(new URL("../src/app/api/cron/index-gap/route.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("skips entirely when queries failed", () => {
    // Raising an incident from a partial read would report our own network blip
    // as a delisting — the mistake the measurement itself refuses to make.
    expect(code).toMatch(/if \(health\.degraded\)/);
    expect(code.indexOf("if (health.degraded)")).toBeLessThan(code.indexOf("indexHealthProblems(health)"));
  });

  it("clears the incident when the problems are gone, so it can fire again later", () => {
    expect(code).toMatch(/clearAlert\("index-gap"/);
    expect(code).toMatch(/alertOwner\(\s*"index-gap"/);
  });

  it("is gated by CRON_SECRET in constant time", () => {
    expect(code).toMatch(/process\.env\.CRON_SECRET/);
    expect(code).toMatch(/safeEqual\(provided, secret\)/);
  });

  it("measures through the shared function, not its own copy", () => {
    expect(code).toMatch(/checkIndexHealth\(cfg\.payTo, getSiteUrl\(\)\)/);
    expect(code, "no second discovery query implementation").not.toMatch(/discovery\/search/);
  });
});

describe("the incident actually reaches a surface", () => {
  const rev = readFileSync(new URL("../src/app/api/revenue/route.ts", import.meta.url), "utf8");

  it("renders every incident kind, not just ai-credits", () => {
    // `ai-credits` was hardcoded. A new kind written to KV and rendered nowhere
    // is a detector nobody reads, which is the bug this panel exists to prevent.
    expect(rev).toMatch(/"index-gap"/);
    expect(rev).toMatch(/openIncidents/);
  });

  it("is registered on a schedule, because an unscheduled detector is not one", () => {
    const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const cron = vercel.crons.find((c) => c.path === "/api/cron/index-gap");
    expect(cron, "index-gap must be in vercel.json crons").toBeTruthy();
    // 04:00 UTC — one hour after index-all re-settles, so the alert is about
    // what the keepalive did NOT fix overnight.
    expect(cron!.schedule).toBe("0 4 * * *");
    const reseed = vercel.crons.find((c) => c.path === "/api/cron/index-all");
    expect(reseed!.schedule).toBe("0 3 * * *");
  });
});
