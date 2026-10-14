import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * token-scout records each scan exactly as it computed it (scout:results), and
 * /api/radar, /api/scout/latest and the live feed expose only whitelisted fields.
 * Recording is best-effort: a KV failure must never break the cron.
 */

const { store, lists, failPush } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  lists: new Map<string, string[]>(),
  failPush: { on: false },
}));

vi.mock("@/lib/kv", () => ({
  kvConfigured: () => true,
  kvGet: vi.fn(async (k: string) => store.get(k) ?? null),
  kvSet: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  kvExpire: vi.fn(async () => {}),
  kvIncr: vi.fn(async () => 1),
  kvLPush: vi.fn(async (k: string, v: string, cap = 200) => {
    if (failPush.on) throw new Error("KV down");
    lists.set(k, [v, ...(lists.get(k) ?? [])].slice(0, cap));
  }),
  kvLRange: vi.fn(async (k: string, start = 0, stop = -1) => {
    const arr = lists.get(k) ?? [];
    return stop === -1 ? arr.slice(start) : arr.slice(start, stop + 1);
  }),
}));

const { newTokens, rugScore, attestScam } = vi.hoisted(() => ({
  newTokens: vi.fn(),
  rugScore: vi.fn(),
  attestScam: vi.fn(),
}));
vi.mock("@/lib/onchain-extra4", () => ({ newTokens }));
vi.mock("@/lib/scores", () => ({ rugScore }));
vi.mock("@/lib/eas-attest", () => ({ attestScam }));
vi.mock("@/lib/radar", () => ({ radarSpreads: async () => null, RADAR_CACHE_SEC: 60 }));

const kv = await import("@/lib/kv");
const live = await import("@/lib/live-events");
const { GET: scout } = await import("@/app/api/cron/token-scout/route");
const { GET: radar } = await import("@/app/api/radar/route");
const { GET: scoutLatest } = await import("@/app/api/scout/latest/route");
const { NextRequest } = await import("next/server");

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const TX = `0x${"ab".repeat(32)}`;

const cronReq = () =>
  new NextRequest("https://402.com.tr/api/cron/token-scout", { headers: { authorization: "Bearer s3cret" } });

/** GoPlus answers per address; Telegram always 200. */
function mockFetch(goplus: Record<string, Record<string, unknown> | "down">) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("api.telegram.org")) return { ok: true, json: async () => ({ ok: true }) };
      const addr = Object.keys(goplus).find((a) => String(url).toLowerCase().includes(a.toLowerCase()));
      const row = addr ? goplus[addr] : undefined;
      if (!row || row === "down") return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ result: { [addr!.toLowerCase()]: row } }) };
    }),
  );
  return calls;
}

const scans = () => (lists.get(live.LIVE_KEYS.scans) ?? []).map((r) => JSON.parse(r));

beforeEach(() => {
  store.clear();
  lists.clear();
  failPush.on = false;
  newTokens.mockReset();
  rugScore.mockReset();
  attestScam.mockReset();
  vi.mocked(kv.kvExpire).mockClear();
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "bot");
  vi.stubEnv("TELEGRAM_SCOUT_CHAT", "chat");
  live.resetFeedShare();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("token-scout records what it computed", () => {
  it("a scored token is recorded with its level, score, signals and sources verbatim", async () => {
    newTokens.mockResolvedValue({ tokens: [{ tokenAddress: A }] });
    mockFetch({ [A]: { token_symbol: "FOO", is_mintable: "1", sell_tax: "0.05" } });
    rugScore.mockResolvedValue({
      rugScore: 82,
      level: "high",
      degraded: false,
      signals: ["mintable supply", "top-10 hold 91%", "liquidity $412"],
      sources: ["base-rpc", "goplus", "goplus-holders", "dexscreener"],
      sourcesMissing: [],
      inputs: { liquidityUsd: 412 },
    });

    const res = await scout(cronReq());
    const body = await res.json();
    expect(body.recorded).toBe(1);
    const [row] = scans();
    expect(row).toMatchObject({
      kind: "scan",
      token: A,
      symbol: "FOO",
      verdict: "scored",
      level: "high",
      score: 82,
      sellSideFlags: ["owner can mint unlimited supply"],
      riskSignals: ["mintable supply", "top-10 hold 91%", "liquidity $412"],
      sources: ["goplus-sell-side", "base-rpc", "goplus", "goplus-holders", "dexscreener"],
      sourcesMissing: [],
      degraded: false,
      attestationTx: null,
    });
    expect(Date.parse(row.at)).not.toBeNaN();
  });

  it("a sell-side hit records the GoPlus flags and the real attestation tx, with no invented level", async () => {
    newTokens.mockResolvedValue({ tokens: [{ tokenAddress: A }] });
    mockFetch({ [A]: { token_symbol: "HP", is_honeypot: "1", sell_tax: "0.99" } });
    attestScam.mockResolvedValue({ uid: TX, txHash: TX, scanUrl: `https://base.easscan.org/attestation/tx/${TX}` });

    await scout(cronReq());
    expect(rugScore).not.toHaveBeenCalled();
    const [row] = scans();
    expect(row).toMatchObject({
      verdict: "sell_side_flags",
      level: null,
      score: null,
      sellSideFlags: ["honeypot — you can buy but not sell", "99% sell tax — you keep little on exit"],
      riskSignals: [],
      sources: ["goplus-sell-side"],
      degraded: false,
      attestationTx: TX,
    });
  });

  it("without Telegram it still scans and records, but posts and attests nothing", async () => {
    vi.stubEnv("TELEGRAM_SCOUT_CHAT", "");
    newTokens.mockResolvedValue({ tokens: [{ tokenAddress: A }] });
    const calls = mockFetch({ [A]: { is_honeypot: "1" } });
    const body = await (await scout(cronReq())).json();
    expect(body.posted).toBe(0);
    expect(attestScam).not.toHaveBeenCalled();
    expect(calls.some((u) => u.includes("telegram"))).toBe(false);
    expect(scans()[0]).toMatchObject({ verdict: "sell_side_flags", attestationTx: null });
  });

  it("degraded scans are marked, with what did not answer", async () => {
    newTokens.mockResolvedValue({ tokens: [{ tokenAddress: A }, { tokenAddress: B }] });
    mockFetch({ [A]: "down", [B]: "down" });
    rugScore
      .mockResolvedValueOnce({
        rugScore: 10,
        level: "unknown",
        degraded: true,
        signals: ["security feed unavailable — honeypot/tax not checked"],
        sources: ["base-rpc", "dexscreener"],
        sourcesMissing: ["goplus", "goplus-holders"],
      })
      .mockRejectedValueOnce(new Error("No on-chain data available for this token"));

    await scout(cronReq());
    const [rowB, rowA] = scans(); // newest first
    expect(rowA).toMatchObject({
      token: A,
      symbol: null,
      verdict: "scored",
      level: "unknown",
      degraded: true,
      sources: ["base-rpc", "dexscreener"],
      sourcesMissing: ["goplus-sell-side", "goplus", "goplus-holders"],
    });
    expect(rowB).toMatchObject({
      token: B,
      verdict: "not_scored",
      level: null,
      score: null,
      degraded: true,
      sources: [],
      sourcesMissing: ["goplus-sell-side", "rug-score"],
    });
  });

  it("a token seen in the last 7 days is not rescanned or re-recorded", async () => {
    newTokens.mockResolvedValue({ tokens: [{ tokenAddress: A }] });
    mockFetch({ [A]: "down" });
    rugScore.mockRejectedValue(new Error("x"));
    await scout(cronReq());
    await scout(cronReq());
    expect(scans()).toHaveLength(1);
  });

  it("a KV write failure does not break the cron — scanning and posting carry on", async () => {
    failPush.on = true;
    newTokens.mockResolvedValue({ tokens: [{ tokenAddress: A }, { tokenAddress: B }] });
    const calls = mockFetch({ [A]: { is_honeypot: "1" }, [B]: "down" });
    rugScore.mockResolvedValue({ rugScore: 75, level: "high", degraded: false, signals: [], sources: [], sourcesMissing: [] });
    const res = await scout(cronReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ recorded: 0, posted: 2, scannedNow: 2 });
    expect(calls.filter((u) => u.includes("telegram"))).toHaveLength(2);
  });
});

describe("scout:results list", () => {
  it("is capped at 200 newest-first and its TTL is refreshed on write", async () => {
    for (let i = 0; i < 210; i++) {
      await live.recordScan(
        {
          token: A, symbol: null, verdict: "scored", level: "low", score: i % 100,
          sellSideFlags: [], riskSignals: [], sources: ["base-rpc"], sourcesMissing: [], degraded: false, attestationTx: null,
        },
        1_700_000_000_000 + i,
      );
    }
    const rows = scans();
    expect(rows).toHaveLength(live.SCANS_CAP);
    expect(Date.parse(rows[0].at)).toBe(1_700_000_000_000 + 209);
    expect(kv.kvExpire).toHaveBeenCalledWith(live.LIVE_KEYS.scans, live.SCANS_TTL_SEC);
  });

  it("drops a fake attestation tx and an unknown level instead of storing them", async () => {
    const ev = await live.recordScan({
      token: A, symbol: "X", verdict: "scored", level: "catastrophic", score: 50,
      sellSideFlags: [], riskSignals: [], sources: ["Not A Source!"], sourcesMissing: [], degraded: false, attestationTx: "pending",
    });
    expect(ev).toMatchObject({ level: null, attestationTx: null, sources: [] });
  });
});

describe("radar, scout/latest and the live feed expose only whitelisted fields", () => {
  const leaky = (atMs: number, extra: Record<string, unknown>) =>
    JSON.stringify({
      kind: "scan",
      id: `${atMs.toString(36)}-abcdef`,
      token: A,
      symbol: "FOO",
      verdict: "scored",
      level: "medium",
      score: 40,
      sellSideFlags: [],
      riskSignals: ["thin liquidity $9000"],
      sources: ["base-rpc"],
      sourcesMissing: [],
      degraded: false,
      attestationTx: null,
      at: new Date(atMs).toISOString(),
      ...extra,
    });
  const EXTRA = { payer: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01", webhook: "https://hooks.example/secret", ip: "1.2.3.4" };
  const SCAN_KEYS = [
    "at", "attestationTx", "attestationUrl", "degraded", "id", "level", "recheck", "riskSignals", "score",
    "sellSideFlags", "sources", "sourcesMissing", "symbol", "token", "verdict",
  ];

  it("/api/radar returns scans with the whitelisted fields, a recheck link and the method text", async () => {
    lists.set(live.LIVE_KEYS.scans, [leaky(1_700_000_000_000, EXTRA)]);
    const body = await (await radar()).json();
    expect(body.scans).toHaveLength(1);
    expect(Object.keys(body.scans[0]).sort()).toEqual(SCAN_KEYS);
    expect(body.scans[0].recheck).toBe(`/api/x402/rug-score?address=${A}&free=1`);
    expect(JSON.stringify(body)).not.toContain("hooks.example");
    expect(body.method.scanFlags).toMatch(/not a verdict/);
    expect(body.method.scanFlags).not.toMatch(/Not shown/);
  });

  it("/api/scout/latest is the same whitelisted view, limited and cacheable", async () => {
    lists.set(live.LIVE_KEYS.scans, [leaky(1_700_000_000_002, EXTRA), leaky(1_700_000_000_001, EXTRA)]);
    const res = await scoutLatest(new NextRequest("https://402.com.tr/api/scout/latest?limit=1"));
    expect(res.headers.get("cache-control")).toContain("s-maxage=60");
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(Object.keys(body.scans[0]).sort()).toEqual(SCAN_KEYS);
    expect(JSON.stringify(body)).not.toContain("1.2.3.4");
  });

  it("the live feed merges scans (at most 10) with paid calls, newest first, without extra fields", async () => {
    const base = 1_700_000_000_000;
    lists.set(
      live.LIVE_KEYS.scans,
      Array.from({ length: 15 }, (_, i) => leaky(base + 100 - i, EXTRA)),
    );
    await live.recordPaidCall("token-risk", 10, base + 1000);
    const feed = await live.readFeed(30);
    expect(feed[0].kind).toBe("paid_call");
    const scanEvents = feed.filter((e) => e.kind === "scan");
    expect(scanEvents).toHaveLength(live.FEED_SCANS);
    expect(JSON.stringify(feed)).not.toContain("hooks.example");
    expect(Object.keys(scanEvents[0]).sort()).toEqual(
      ["kind", ...SCAN_KEYS.filter((k) => k !== "recheck" && k !== "attestationUrl")].sort(),
    );
  });
});
