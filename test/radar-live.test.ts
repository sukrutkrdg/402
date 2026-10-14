import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * /radar and /api/events/live may only show what was measured or recorded.
 * A previous "radar" invented honeypot alerts against real addresses and a
 * "live" stream that never closed; these tests pin the opposite behaviour.
 */

const { store, lists, sets, hashes } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  lists: new Map<string, string[]>(),
  sets: new Map<string, Set<string>>(),
  hashes: new Map<string, Record<string, number>>(),
}));

vi.mock("@/lib/kv", () => ({
  kvConfigured: () => true,
  kvGet: vi.fn(async (k: string) => store.get(k) ?? null),
  kvSet: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  kvIncrBy: vi.fn(async (k: string, by: number) => {
    const n = Number(store.get(k) ?? 0) + by;
    store.set(k, String(n));
    return n;
  }),
  kvHIncrBy: vi.fn(async (k: string, f: string, by = 1) => {
    const h = hashes.get(k) ?? {};
    h[f] = (h[f] ?? 0) + by;
    hashes.set(k, h);
  }),
  kvHGetAll: vi.fn(async (k: string) => hashes.get(k) ?? {}),
  kvSAdd: vi.fn(async (k: string, m: string) => void (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(m)),
  kvSRem: vi.fn(async (k: string, m: string) => void sets.get(k)?.delete(m)),
  kvSMembers: vi.fn(async (k: string) => [...(sets.get(k) ?? [])]),
  kvLPush: vi.fn(async (k: string, v: string, cap = 200) => {
    lists.set(k, [v, ...(lists.get(k) ?? [])].slice(0, cap));
  }),
  kvLRange: vi.fn(async (k: string, start = 0, stop = -1) => {
    const arr = lists.get(k) ?? [];
    return stop === -1 ? arr.slice(start) : arr.slice(start, stop + 1);
  }),
}));

const { deliverWebhook } = vi.hoisted(() => ({ deliverWebhook: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/webhook-delivery", () => ({
  deliverWebhook,
  MAX_DELIVERY_ATTEMPTS: 3,
  newWebhookSecret: () => "whsec_test",
}));

const { computeRadarSpreads, RADAR_WATCHLIST } = await import("@/lib/radar");
const { dexSpread } = await import("@/lib/dex-spread");
const { checkRugMonitors } = await import("@/lib/rug-monitor");
const { recordExternalRevenue } = await import("@/lib/keepalive-economics");
const live = await import("@/lib/live-events");
const { liveEventStream, LIVE_STREAM_MS } = await import("@/lib/live-stream");
const { GET: checkAlerts } = await import("@/app/api/cron/check-alerts/route");
const { NextRequest } = await import("next/server");

const PAYER = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const WEBHOOK = "https://hooks.customer-example.com/very/secret/path";
const SECRET = "whsec_super_secret_value";
const TOKEN = "0x1111111111111111111111111111111111111111";

const dexResponse = (pairs: unknown[]) => ({ ok: true, json: async () => ({ pairs }) });
const pool = (base: string, dex: string, price: number, liq: number) => ({
  chainId: "base",
  dexId: dex,
  pairAddress: `0x${dex.padEnd(40, "0").slice(0, 40)}`,
  baseToken: { address: base, symbol: "T" },
  quoteToken: { symbol: "USDC" },
  priceUsd: String(price),
  liquidity: { usd: liq },
  volume: { h24: 1 },
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value);
  }
}
const sseIds = (text: string) => [...text.matchAll(/^id: (.+)$/gm)].map((m) => m[1]);

beforeEach(() => {
  store.clear();
  lists.clear();
  sets.clear();
  hashes.clear();
  deliverWebhook.mockClear();
  live.resetFeedShare();
});
afterEach(() => vi.unstubAllGlobals());

describe("radar spreads", () => {
  it("marks a token it could not read as no_data with null numbers — never 0", async () => {
    const [failing, single, ...rest] = RADAR_WATCHLIST;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.toLowerCase().includes(failing.address.toLowerCase())) return { ok: false, status: 503, json: async () => ({}) };
        if (url.toLowerCase().includes(single.address.toLowerCase())) return dexResponse([pool(single.address, "aerodrome", 1, 1e6)]);
        const t = rest.find((r) => url.toLowerCase().includes(r.address.toLowerCase()))!;
        return dexResponse([pool(t.address, "aerodrome", 1.0, 2e6), pool(t.address, "uniswap", 1.0025, 1e6)]);
      }),
    );

    const snap = await computeRadarSpreads(dexSpread);
    expect(snap.rows).toHaveLength(RADAR_WATCHLIST.length);

    const bad = snap.rows.find((r) => r.address === failing.address)!;
    expect(bad.status).toBe("no_data");
    expect(bad.reason).toMatch(/DexScreener unavailable/);
    expect(bad.spreadBps).toBeNull();
    expect(bad.liquidVenues).toBeNull();
    expect(bad.totalVenues).toBeNull();
    expect(bad.venues).toEqual([]);

    // One liquid venue: read fine, but there is no cross-venue spread to report.
    const one = snap.rows.find((r) => r.address === single.address)!;
    expect(one.status).toBe("ok");
    expect(one.verdict).toBe("single_venue");
    expect(one.spreadBps).toBeNull();

    const ok = snap.rows.find((r) => r.address === rest[0].address)!;
    expect(ok.status).toBe("ok");
    expect(ok.spreadBps).toBe(25); // 0.25% measured gap
    expect(ok.venues.map((v) => v.dex)).toEqual(["aerodrome", "uniswap"]);
    expect(snap.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("a total outage reads as no_data on every row, not a wall of zeros", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const snap = await computeRadarSpreads(dexSpread);
    for (const r of snap.rows) {
      expect(r.status).toBe("no_data");
      expect(r.spreadBps).toBeNull();
    }
  });
});

describe("alert firings list", () => {
  it("records a real rug-watch firing with token/type/drop/time only — no id, webhook or secret", async () => {
    const watch = {
      id: "11111111-abc", token: TOKEN, webhook: WEBHOOK, secret: SECRET,
      baselineLiquidityUsd: 10000, dropPct: 50, createdAt: "2026-10-01T00:00:00.000Z", fired: false,
    };
    store.set(`rugwatch:${watch.id}`, JSON.stringify(watch));
    sets.set("rugwatch:active", new Set([watch.id]));
    vi.stubGlobal("fetch", vi.fn(async () => dexResponse([pool(TOKEN, "aerodrome", 1, 1000)])));

    const res = await checkRugMonitors();
    expect(res.fired).toBe(1);

    const alerts = await live.readAlertFirings();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "alert", type: "rug_warning", token: TOKEN, changePct: -90 });
    const raw = JSON.stringify([...lists.values()]);
    expect(raw).not.toContain("customer-example");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(watch.id);
  });

  it("does not record anything when a monitor is checked but does not fire", async () => {
    const watch = { id: "22222222-abc", token: TOKEN, webhook: "", baselineLiquidityUsd: 10000, dropPct: 50, createdAt: "x", fired: false };
    store.set(`rugwatch:${watch.id}`, JSON.stringify(watch));
    sets.set("rugwatch:active", new Set([watch.id]));
    vi.stubGlobal("fetch", vi.fn(async () => dexResponse([pool(TOKEN, "aerodrome", 1, 9000)])));
    await checkRugMonitors();
    expect(await live.readAlertFirings()).toEqual([]);
    expect(await live.readFeed()).toEqual([]);
  });

  it("records a real price-alert firing from the check-alerts cron, without its id/webhook/secret", async () => {
    process.env.CRON_SECRET = "cron-test";
    const id = "alrt_firing1";
    store.set(
      `alert:${id}`,
      JSON.stringify({
        id, token: TOKEN, threshold: 1, direction: "below", webhook: WEBHOOK, secret: SECRET,
        priceAtCreate: 2, createdAt: "2026-10-01T00:00:00.000Z", fired: false,
      }),
    );
    sets.set("alerts:active", new Set([id]));
    vi.stubGlobal("fetch", vi.fn(async () => dexResponse([pool(TOKEN, "aerodrome", 0.5, 1e6)])));

    const res = await checkAlerts(new NextRequest("https://x.test/api/cron/check-alerts", { headers: { authorization: "Bearer cron-test" } }));
    const body = (await res.json()) as { fired: number };
    expect(body.fired).toBe(1);

    const alerts = await live.readAlertFirings();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: "price_alert", token: TOKEN, direction: "below", changePct: -75 });
    const raw = JSON.stringify([...lists.values()]);
    expect(raw).not.toContain("customer-example");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(id);
  });

  it("readers drop fields that are not on the whitelist even if they reach storage", async () => {
    lists.set(live.LIVE_KEYS.alerts, [
      JSON.stringify({ kind: "alert", id: "abc-0a0b0c", type: "rug_warning", token: TOKEN, changePct: -60, at: new Date().toISOString(), webhook: WEBHOOK, payer: PAYER }),
      "not json",
      JSON.stringify({ kind: "alert", id: "abc-0a0b0d", type: "honeypot", token: TOKEN, at: new Date().toISOString() }),
    ]);
    const out = await live.readAlertFirings();
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).not.toMatch(/customer-example|abcdef0123/i);
  });
});

describe("live feed", () => {
  it("paid calls by outside payers enter the feed as service + price + time, never the payer", async () => {
    await recordExternalRevenue(30, "token-risk", PAYER);
    const feed = await live.readFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: "paid_call", service: "token-risk", priceUsd: 0.03 });
    expect(Object.keys(feed[0]).sort()).toEqual(["at", "id", "kind", "priceUsd", "service"]);
    expect(JSON.stringify([...lists.values()]).toLowerCase()).not.toContain(PAYER.toLowerCase().slice(2, 12));
  });

  it("streams only recorded events, picks up new ones, heartbeats, and closes in bounded time", async () => {
    await recordExternalRevenue(10, "dex-spread", PAYER);
    await live.recordAlertFiring({ type: "rug_warning", token: TOKEN, changePct: -70 });
    const before = await live.readFeed();

    const t0 = Date.now();
    const stream = liveEventStream({ durationMs: 400, pollMs: 40, heartbeatMs: 100, read: () => live.readFeed() });
    setTimeout(() => void live.recordPaidCall("token-risk", 5), 120);
    const text = await readAll(stream);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(2000);
    expect(text).toMatch(/^retry: \d+/);
    expect(text).toContain(": heartbeat");
    expect(text).toContain("event: bye");

    const recorded = new Set((await live.readFeed()).map((e) => e.id));
    const ids = sseIds(text);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(recorded.has(id)).toBe(true);
    expect(ids.slice(0, 2)).toEqual(before.map((e) => e.id).reverse()); // backlog oldest-first
    expect(text.toLowerCase()).not.toContain(PAYER.toLowerCase().slice(2, 12));
  });

  it("sends nothing but status/heartbeat/bye when nothing was recorded", async () => {
    const text = await readAll(liveEventStream({ durationMs: 150, pollMs: 30, heartbeatMs: 60, read: () => live.readFeed() }));
    expect(sseIds(text)).toEqual([]);
    expect(text).toContain('"recordedEvents":0');
    expect(text).not.toMatch(/event: (paid_call|alert)/);
  });

  it("resumes after Last-Event-ID without repeating", async () => {
    await live.recordPaidCall("token-risk", 5, Date.now() - 2000);
    await live.recordPaidCall("dex-spread", 5, Date.now() - 1000);
    const [newest, oldest] = await live.readFeed();
    const text = await readAll(liveEventStream({ lastEventId: oldest.id, durationMs: 60, pollMs: 30, read: () => live.readFeed() }));
    expect(sseIds(text)).toEqual([newest.id]);
  });

  it("never stays open longer than 55s, whatever the caller asks", () => {
    expect(LIVE_STREAM_MS).toBeLessThanOrEqual(55_000);
  });
});
