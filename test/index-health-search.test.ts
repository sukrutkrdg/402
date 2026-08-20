import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The check that tells us whether anyone can find us must not invent a delisting.
 *
 * This used to page the full ~15k-row sweep, an instrument with a measured way
 * of lying: `limit` rounds to the nearest ten, paging keys on
 * `offset // effective_limit`, and a stride that disagrees with the effective
 * page size skips whole pages whose rows then read as absent. Our stride was
 * aligned by luck rather than by design.
 *
 * `search?payTo=` cannot skip a page, but it cannot enumerate either — measured:
 * limit caps at 20, 21 is a 400, offset is ignored, and meta.searchToken is
 * regenerated per request rather than being a cursor. So the route asks one
 * narrow question per service, and the failure that matters is a question that
 * did not get an answer: reporting that as `missing` would turn an outage into a
 * delisting and send the keepalive cron out to pay for re-seeds nothing needed.
 */
const { cfgMock, servicesMock } = vi.hoisted(() => ({
  cfgMock: {
    getConfig: vi.fn(() => ({ statsToken: "tok", payTo: "0xAAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA" })),
    getSiteUrl: vi.fn(() => "https://402.com.tr"),
  },
  servicesMock: {
    SERVICES: [
      { id: "token-risk", price: "$0.02" },
      { id: "safe-to-send", price: "$0.01" },
      { id: "ai-translate", price: "$0.03" },
    ],
  },
}));
vi.mock("@/lib/config", () => cfgMock);
vi.mock("@/lib/services", () => servicesMock);
vi.mock("@/lib/secure", () => ({ safeEqual: (a: string, b: string) => a === b }));

import { GET } from "@/app/api/index-health/route";

const req = (token = "tok") =>
  ({ headers: new Headers({ "x-stats-token": token }) }) as unknown as Parameters<typeof GET>[0];

/** One indexed row, as the search path returns it. */
const row = (id: string, amountMicro: string, lastCalledAt: string) => ({
  resource: `https://402.com.tr/api/x402/${id}`,
  lastUpdated: lastCalledAt,
  accepts: [{ amount: amountMicro, payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
  quality: { lastCalledAt, l30DaysTotalCalls: 3 },
});

const ok = (resources: unknown[]) => ({ ok: true, json: async () => ({ resources }) });
const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("index-health via search?payTo", () => {
  it("asks one targeted query per service and never pages an offset", async () => {
    const f = vi.fn(async () => ok([]));
    vi.stubGlobal("fetch", f);
    await GET(req());

    expect(f).toHaveBeenCalledTimes(3);
    for (const [url] of f.mock.calls as unknown as Array<[string]>) {
      expect(url).toContain("/discovery/search?");
      expect(url).toContain("payTo=");
      expect(url, "offset is ignored on this path — using it would be a lie to ourselves").not.toContain("offset=");
    }
    const queried = (f.mock.calls as unknown as Array<[string]>).map(([u]) => decodeURIComponent(u.split("query=")[1] ?? ""));
    expect(queried.sort()).toEqual(["ai-translate", "safe-to-send", "token-risk"]);
  });

  it("reports a service whose query FAILED as unchecked, not as missing", async () => {
    // The whole point. A 502 from the discovery API is not evidence of delisting.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (String(url).includes("safe-to-send") ? { ok: false, json: async () => ({}) } : ok([]))),
    );
    const body = await (await GET(req())).json();

    expect(body.unchecked).toEqual(["safe-to-send"]);
    expect(body.missing.map((m: { id: string }) => m.id), "an unanswered query must not become a delisting").not.toContain("safe-to-send");
    expect(body.degraded).toBe(true);
  });

  it("still reports a genuinely absent service as missing", async () => {
    // An empty answer IS an answer — the distinction only works if this half holds.
    vi.stubGlobal("fetch", vi.fn(async () => ok([])));
    const body = await (await GET(req())).json();
    expect(body.missingCount).toBe(3);
    expect(body.degraded).toBe(false);
  });

  it("folds in a query's by-catch, because every returned row is ours", async () => {
    // The payTo filter means neighbours in a fuzzy result are our other services.
    // One query answering for three is the point of not enumerating.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("token-risk")
          ? ok([row("token-risk", "20000", ago(1)), row("safe-to-send", "10000", ago(1)), row("ai-translate", "30000", ago(1))])
          : ok([]),
      ),
    );
    const body = await (await GET(req())).json();
    expect(body.indexedSeen).toBe(3);
    expect(body.missingCount).toBe(0);
  });

  it("flags a price the index quotes below what we charge", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([row("token-risk", "10000", ago(1))]))); // indexed $0.01 vs live $0.02
    const body = await (await GET(req())).json();
    const stale = body.stalePrice.find((s: { id: string }) => s.id === "token-risk");
    expect(stale.indexedUsd).toBe(0.01);
    expect(stale.liveUsd).toBe(0.02);
    expect(stale.underQuoted, "this is the one that breaks purchases").toBe(true);
  });

  it("counts down to eviction from lastCalledAt, not from lastUpdated alone", async () => {
    // The catalog drops a row 30 days after its stored lastCalledAt. A service
    // last paid 25 days ago has five left, and nothing we deploy changes that.
    vi.stubGlobal("fetch", vi.fn(async () => ok([row("token-risk", "20000", ago(25))])));
    const body = await (await GET(req())).json();
    const soon = body.expiringSoon.find((e: { id: string }) => e.id === "token-risk");
    expect(soon.daysLeft).toBe(5);
    expect(Date.parse(soon.evictsAt)).toBeGreaterThan(Date.now());
  });

  it("leaves a freshly-settled service out of the eviction list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([row("token-risk", "20000", ago(1))])));
    const body = await (await GET(req())).json();
    expect(body.expiringSoonCount).toBe(0);
  });

  it("calls the orphan list what it is — a floor, not an inventory", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([row("retired-thing", "20000", ago(1))])));
    const body = await (await GET(req())).json();
    expect(body.orphansSeen).toContain("retired-thing");
    expect(body.orphans, "the enumerable name is gone — search cannot enumerate").toBeUndefined();
  });

  it("stays locked to the owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([])));
    expect((await GET(req("wrong"))).status).toBe(401);
  });
});
