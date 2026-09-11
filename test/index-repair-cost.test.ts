import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { indexHealthRepair, indexHealthProblems, EXPIRING_ALERT_DAYS, type IndexHealth } from "@/lib/index-health";

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
    // Inside EXPIRING_ALERT_DAYS: only rows the alert actually names get priced.
    const h: IndexHealth = {
      ...base,
      expiringSoonCount: 2,
      expiringSoon: [expiring("token-risk", 2), expiring("pre-trade-gate", 4)],
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

describe("the alert threshold cannot collide with the refresh cycle", () => {
  /**
   * The bug this pins, found 2026-09-07.
   *
   * A listing is evicted 30 days after its last settlement, and the keepalive
   * only touches it once its 21-day freshness key expires. So a service running
   * exactly as designed reaches its turn with 30 - 21 = 9 days left, every
   * cycle. Alerting at 10 days therefore pages every single morning about
   * endpoints that are fine — and alert-owner.ts's own header says a thing that
   * pages daily becomes a filter rule that hides the next real alert. It
   * reported 24 services and a $0.94 repair for a conveyor that was not behind.
   */
  it("keeps the alert threshold below the cycle floor", () => {
    expect(EXPIRING_ALERT_DAYS).toBeLessThan(30 - 21);
  });

  it("does not alert on a service sitting at the cycle's natural floor", () => {
    const floor = 30 - 21; // EVICTION_DAYS minus the freshness window, in days
    const h: IndexHealth = {
      ...base,
      expiringSoonCount: 1,
      expiringSoon: [expiring("token-risk", floor)],
    };
    expect(indexHealthProblems(h)).toEqual([]);
    expect(indexHealthRepair(h).count).toBe(0);
  });

  it("still alerts when the conveyor has genuinely fallen behind", () => {
    const h: IndexHealth = {
      ...base,
      expiringSoonCount: 1,
      expiringSoon: [expiring("token-risk", 3)],
    };
    const p = indexHealthProblems(h);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/token-risk \(3d\)/);
    expect(indexHealthRepair(h).count).toBe(1);
  });

  it("keeps reporting the wider set even when it does not alert", () => {
    // The 10-day collection stays in the JSON for visibility; only the alert
    // narrows. Losing the report would trade one blind spot for another.
    const h: IndexHealth = {
      ...base,
      expiringSoonCount: 2,
      expiringSoon: [expiring("token-risk", 9), expiring("gas-oracle", 8)],
    };
    expect(h.expiringSoon).toHaveLength(2);
    expect(indexHealthProblems(h)).toEqual([]);
  });

  it("alerts on only the urgent rows when the two sets overlap", () => {
    const h: IndexHealth = {
      ...base,
      expiringSoonCount: 3,
      expiringSoon: [expiring("token-risk", 2), expiring("gas-oracle", 9), expiring("chain-status", 10)],
    };
    const p = indexHealthProblems(h);
    expect(p[0]).toMatch(/1 row\(s\)/);
    expect(p[0]).toMatch(/token-risk/);
    expect(p[0]).not.toMatch(/gas-oracle/);
  });
});

describe("a withdrawn service is not a discovery failure", () => {
  const src = readFileSync("src/lib/index-health.ts", "utf8");

  /**
   * Hiding company-search on 2026-09-10 — its upstream began demanding a key —
   * immediately raised "absent from discovery, no agent can find them" about a
   * service deliberately taken off sale. A hidden service is never settled, so
   * it can never be indexed, so the incident could never clear.
   *
   * It had not bitten before by luck alone: the only other hideable services
   * key off s3Config(), which is set in production, so the hidden set was empty
   * there.
   */
  it("measures the sellable catalogue, not every declared service", () => {
    expect(src).toMatch(/const catalogue = SERVICES\.filter\(\(s\) => !s\.hidden\)/);
  });

  it("counts, queries and compares against that same set", () => {
    expect(src).toMatch(/catalog: catalogue\.length/);
    expect(src).toMatch(/for \(let i = 0; i < catalogue\.length; i \+= BATCH\)/);
    expect(src).toMatch(/for \(const s of catalogue\)/);
    // Orphan detection too: a hidden service still indexed from an earlier life
    // is a real orphan, and comparing against the unfiltered list would hide it.
    expect(src).toMatch(/!catalogue\.some\(\(s\) => s\.id === id\)/);
  });

  it("keeps the same definition the refresh cron spends against", () => {
    // index-all pays for `SERVICES.filter((s) => !s.hidden)`. If health measured
    // a wider set than the cron can ever fix, the gap would be permanent by
    // construction.
    const cron = readFileSync("src/app/api/cron/index-all/route.ts", "utf8");
    expect(cron).toMatch(/SERVICES\.filter\(\(s\) => !s\.hidden\)/);
  });
});

describe("the keepalive conveyor is not blocked by one expensive service", () => {
  const cron = readFileSync("src/app/api/cron/index-all/route.ts", "utf8");

  /**
   * Eight live endpoints — b20-gate, b20-guard, b20-batch, token-price and four
   * more — had fallen out of discovery by 2026-09-11 while the cron reported
   * healthy runs every day. Its two 75c reports cost more than the whole 60c
   * per-run cap, and the exemption that lets one through was folding that price
   * into `spent`. So the opening purchase put the run over budget and deferred
   * every remaining service: twelve slots a day, one service settled, listings
   * aging past the 30-day eviction while the output looked normal.
   *
   * The ordering change of 2026-09-05 did not cause it. Before then the
   * conveyor walked catalogue order, where those reports sit late and rarely
   * reached the front. Sorting by urgency was right; it surfaced this.
   */
  it("does not let the exempted price consume the run's budget", () => {
    expect(cron).toMatch(/let exempted = 0;/);
    expect(cron).toMatch(/const exempt = spent === 0 && exempted === 0 && cents > MAX_SPEND_CENTS;/);
  });

  it("bounds the worst case at the cap plus one price, as the comment promises", () => {
    const cap = Number(cron.match(/const MAX_SPEND_CENTS = (\d+)/)?.[1]);
    const perRun = Number(cron.match(/const MAX_PER_RUN = (\d+)/)?.[1]);
    expect(cap).toBeGreaterThan(0);
    expect(perRun).toBeGreaterThan(0);
    // Deliberately still below the dearest service. The exemption is what
    // reaches those, not a bigger number: raising the cap past them would make
    // it dead code and quietly remove the guard it stands in for.
    expect(cap).toBeLessThan(75);
  });
});
