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
    // What we serve. The staleNetworks check is the gap between this and what
    // the index advertises, so the mock has to carry it.
    ALL_NETWORKS: ["eip155:8453", "eip155:137"],
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
    // A range, not an exact value: the route floors the remainder, so a stamp
    // written 25 days ago is 5.0 days out at time zero and 4.999 a millisecond
    // later. Asserting 5 exactly made this pass alone and fail under suite load.
    // Flooring is the right direction for the operator — it never tells you that
    // you have more time than you do — so the test bends, not the route.
    expect(soon.daysLeft).toBeGreaterThanOrEqual(4);
    expect(soon.daysLeft).toBeLessThanOrEqual(5);
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

/**
 * The chain list freezes exactly like the price does, and for a month nothing
 * said so.
 *
 * Polygon was added to `accepts` on 2026-08-30. On 2026-09-03, 7 of 67 indexed
 * rows advertised it — precisely the ones settled after the deploy; the other 60
 * still quoted Base alone, because a discovery record keeps whatever it saw at
 * its last settlement. This check reported a clean bill throughout, because it
 * compared amounts and ignored networks.
 *
 * What that cost was not a broken payment but a broken measurement: the
 * pre-registered question "did anyone pay on Polygon in 14 days" was being asked
 * of a catalogue that had never offered Polygon to 90% of the agents reading it.
 * A zero there says nothing about demand, and without this check nothing would
 * have distinguished the two.
 */
const netRow = (id: string, networks: string[]) => ({
  resource: `https://402.com.tr/api/x402/${id}`,
  lastUpdated: ago(1),
  accepts: networks.map((network) => ({ amount: "20000", network, payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })),
  quality: { lastCalledAt: ago(1), l30DaysTotalCalls: 3 },
});

describe("staleNetworks — a chain nobody can see is a chain nobody can choose", () => {
  it("flags a row that advertises only some of the chains we serve", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([netRow("token-risk", ["eip155:8453"])])));
    const body = await (await GET(req())).json();
    expect(body.staleNetworksCount).toBe(1);
    expect(body.staleNetworks[0]).toMatchObject({
      id: "token-risk",
      indexed: ["eip155:8453"],
      missingNetworks: ["eip155:137"],
    });
  });

  it("says nothing about a row that already carries every chain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([netRow("token-risk", ["eip155:8453", "eip155:137"])])));
    const body = await (await GET(req())).json();
    expect(body.staleNetworksCount).toBe(0);
  });

  it("does not invent a fault from a row that declared no network at all", async () => {
    // An accepts entry without a `network` field tells us nothing about which
    // chains are advertised — treating that silence as "Polygon is missing"
    // would flag the whole catalogue on a field the index simply did not send.
    vi.stubGlobal("fetch", vi.fn(async () => ok([row("token-risk", "20000", ago(1))])));
    const body = await (await GET(req())).json();
    expect(body.staleNetworksCount).toBe(0);
  });

  it("publishes what we serve, so the gap is readable without the source", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([netRow("token-risk", ["eip155:8453"])])));
    const body = await (await GET(req())).json();
    expect(body.serve).toEqual(["eip155:8453", "eip155:137"]);
  });

  it("counts a service needing a re-settle once, however many ways it is stale", async () => {
    // Wrong price AND wrong chains is still one settlement, so the estimate must
    // not bill it twice.
    vi.stubGlobal("fetch", vi.fn(async () => ok([{
      resource: "https://402.com.tr/api/x402/token-risk",
      lastUpdated: ago(1),
      accepts: [{ amount: "10000", network: "eip155:8453", payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      quality: { lastCalledAt: ago(1), l30DaysTotalCalls: 3 },
    }])));
    const body = await (await GET(req())).json();
    expect(body.stalePriceCount).toBe(1);
    expect(body.staleNetworksCount).toBe(1);
    // token-risk is $0.02; the other two mocked services are missing entirely.
    expect(body.reseedCount).toBe(3);
    expect(body.reseedCostUsd).toBeCloseTo(0.02 + 0.01 + 0.03, 6);
  });

  it("warns that a chain measurement is meaningless while rows are stale", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([netRow("token-risk", ["eip155:8453"])])));
    const body = await (await GET(req())).json();
    expect(body.note).toMatch(/chain list/i);
  });
});
