import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { indexHealthRepair, indexHealthProblems, type IndexHealth } from "@/lib/index-health";

/**
 * An alert that quotes the wrong number is worse than one that quotes none.
 *
 * On 2026-09-05 the index-gap alert reported ten services about to evict and
 * then told the operator the repair was "119 service(s), about $10.233". That
 * figure is `reseedCount`, which includes the stale-network rows the same cron
 * deliberately never alerts on. Both readings of it are wrong: act on it and
 * you overspend twelvefold, dismiss it as overblown and you miss the ten.
 */

const base: IndexHealth = {
  checkedAt: "2026-09-05T04:00:00.000Z",
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
  serve: ["eip155:8453"],
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

const expiring = (id: string, daysLeft: number) => ({
  id,
  lastCalledAt: "2026-08-06T00:00:00.000Z",
  evictsAt: "2026-09-15T00:00:00.000Z",
  daysLeft,
});

describe("what the repair figure covers", () => {
  it("is nothing when there is nothing to repair", () => {
    expect(indexHealthRepair(base)).toEqual({ count: 0, costUsd: 0 });
  });

  /**
   * The bug, pinned. Stale networks drain themselves one settlement at a time
   * and are never alerted on, so they must not appear in the price quoted
   * beside an alert.
   */
  it("ignores stale networks, which the alert never asks anyone to fix", () => {
    const h: IndexHealth = {
      ...base,
      staleNetworksCount: 109,
      staleNetworks: Array.from({ length: 109 }, (_, i) => ({
        id: `svc-${i}`,
        indexed: ["eip155:8453"],
        missingNetworks: ["eip155:137"],
        lastUpdated: "2026-08-01T00:00:00.000Z",
      })),
    };
    expect(indexHealthProblems(h)).toEqual([]);
    expect(indexHealthRepair(h).count).toBe(0);
  });

  it("counts a service once when it is both expiring and missing", () => {
    const h: IndexHealth = {
      ...base,
      missingCount: 1,
      missing: [{ id: "token-risk", price: "$0.03" }],
      expiringSoonCount: 1,
      expiringSoon: [expiring("token-risk", 10)],
    };
    expect(indexHealthRepair(h).count).toBe(1);
  });

  it("prices each affected service at its own catalogue price", () => {
    const h: IndexHealth = {
      ...base,
      expiringSoonCount: 2,
      expiringSoon: [expiring("token-risk", 10), expiring("pre-trade-gate", 10)],
    };
    const r = indexHealthRepair(h);
    expect(r.count).toBe(2);
    // token-risk $0.03 + pre-trade-gate $0.10.
    expect(r.costUsd).toBeCloseTo(0.13, 4);
  });

  it("does not price an under-quote as free, since a settlement fixes it", () => {
    const h: IndexHealth = {
      ...base,
      stalePriceCount: 1,
      underQuotedCount: 1,
      stalePrice: [
        { id: "token-risk", indexedUsd: 0.01, liveUsd: 0.03, lastUpdated: "2026-08-01T00:00:00.000Z", underQuoted: true },
      ],
    };
    expect(indexHealthRepair(h).count).toBe(1);
    expect(indexHealthRepair(h).costUsd).toBeGreaterThan(0);
  });

  it("leaves an over-quote out, because the alert leaves it out too", () => {
    const h: IndexHealth = {
      ...base,
      stalePriceCount: 1,
      underQuotedCount: 0,
      stalePrice: [
        { id: "token-risk", indexedUsd: 0.05, liveUsd: 0.03, lastUpdated: "2026-08-01T00:00:00.000Z", underQuoted: false },
      ],
    };
    expect(indexHealthRepair(h).count).toBe(0);
  });
});

describe("the alert quotes the repair, not the backlog", () => {
  const src = readFileSync("src/app/api/cron/index-gap/route.ts", "utf8");

  it("interpolates repair figures into the message", () => {
    const msg = src.slice(src.indexOf("const repair"), src.indexOf("return NextResponse.json(\n    {"));
    expect(msg).toMatch(/\$\{repair\.count\}/);
    expect(msg).toMatch(/\$\{repair\.costUsd\}/);
    expect(msg).not.toMatch(/\$\{health\.reseedCount\}/);
  });
});

describe("the refresh cron spends on whatever is closest to eviction", () => {
  const src = readFileSync("src/app/api/cron/index-all/route.ts", "utf8");

  /**
   * The budget was never the problem. Twelve settlements a day clears 142
   * services well inside a 30-day window; spending them in catalogue order is
   * what left ten endpoints inside their last ten days.
   */
  it("sorts the stale set by when each last settled", () => {
    expect(src).toMatch(/staleSet\.sort\(\(a, b\) => a\.seededAt - b\.seededAt\)/);
    expect(src.indexOf("staleSet.sort")).toBeLessThan(src.indexOf("for (const { s } of staleSet)"));
  });

  it("treats a service with no timestamp as the most urgent, not the least", () => {
    // Number("") is 0 and Number(null) is 0, but Number(undefined) is NaN —
    // a NaN here would sort unpredictably and could park a never-settled
    // service at the back forever.
    expect(src).toMatch(/Number\.isFinite\(seededAt\) && seen \? seededAt : 0/);
  });

  it("dates the timestamp on a successful settlement", () => {
    expect(src).toMatch(/kvSet\(indexSeededKey\(s\.id\), String\(Date\.now\(\)\), INDEX_SEEDED_SECONDS\)/);
  });

  it("lets an organic purchase update it too, so the cron's bill falls as demand rises", () => {
    const paid = readFileSync("src/app/api/x402/[service]/route.ts", "utf8");
    expect(paid).toMatch(/kvSet\(indexSeededKey\(service\.id\), String\(Date\.now\(\)\), INDEX_SEEDED_SECONDS\)/);
  });
});
