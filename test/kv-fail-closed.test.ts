import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * KV outage behavior: when KV IS configured but unreachable (quota exhausted,
 * network down), MONEY/quota guards must FAIL CLOSED — a KV outage must never
 * grant a reservation or disable rate limiting entirely.
 *
 * The one deliberate exception is the FREE TIER: it fails OPEN via a bounded
 * per-instance in-memory cap (a denied free try is a lost conversion, and a
 * cold-start-resetting counter still prevents an unlimited tier). The full
 * fail-open contract lives in free-tier-failopen.test.ts; here we only pin that
 * the outage path grants the first try and flags `degraded` so the route knows.
 *
 * kv.ts reads its env at module load, so each test re-imports the modules with
 * the env stubbed and fetch failing.
 */

async function freshModules() {
  vi.resetModules();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://kv.test.invalid");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
  // Every KV REST call fails — simulates outage / exhausted quota.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("kv down")));
  const kv = await import("@/lib/kv");
  const freeTier = await import("@/lib/free-tier");
  const rateLimit = await import("@/lib/rate-limit");
  return { kv, freeTier, rateLimit };
}

describe("KV outage → fail closed", () => {
  beforeEach(() => {
    process.env.FREE_TIER_DAILY = "1";
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("kvIncr returns null (not 0) when KV is configured but unreachable", async () => {
    const { kv } = await freshModules();
    expect(kv.kvConfigured()).toBe(true);
    expect(await kv.kvIncr("some-key", 60)).toBeNull();
    expect(await kv.kvIncr("some-key")).toBeNull();
  });

  it("the free tier FAILS OPEN (bounded) during a KV outage", async () => {
    // A denied free call is a lost conversion; the in-memory fallback grants the
    // first try per instance and still caps it, so an outage can't open an
    // unlimited tier. Full contract: free-tier-failopen.test.ts.
    const { freeTier } = await freshModules();
    const key = `ip-${Math.random()}`;
    const first = await freeTier.consumeFree(key);
    expect(first.allowed).toBe(true);
    expect(first.degraded).toBe(true);
    expect((await freeTier.consumeFree(key)).allowed).toBe(false); // capped per instance
  });

  it("a capped outage call is flagged degraded (not spent), so the route falls to paid", async () => {
    // "You used today's call" (spent) earns a preview. "We could not count"
    // (degraded) must NOT — it falls through to the paid 402. Opposite handling,
    // same allowed:false shape, told apart by `degraded`. See the route assertion below.
    const { freeTier } = await freshModules();
    const key = `ip-${Math.random()}`;
    await freeTier.consumeFree(key); // first try, allowed
    const capped = await freeTier.consumeFree(key); // over the in-memory cap
    expect(capped.allowed).toBe(false);
    expect(capped.degraded).toBe(true);
  });

  it("a spent quota is not marked degraded", async () => {
    // Same shape, ordinary cause — this one must still get its preview.
    vi.resetModules();
    const freeTier = await import("@/lib/free-tier");
    const key = `spent-${Math.random()}`;
    expect((await freeTier.consumeFree(key)).allowed).toBe(true);
    const second = await freeTier.consumeFree(key);
    expect(second.allowed).toBe(false);
    expect(second.degraded).toBe(false);
  });

  it("the route refuses to serve a preview it cannot meter", async () => {
    // Closing the free tier does not stop the handler running: the refusal falls
    // into the preview branch, and the preview branch runs the FULL handler. Its
    // two guards are both KV — the preview cache, and a limiter that degrades to
    // a per-instance counter a cold start resets. So during an outage every
    // ?free=1 request served real upstream cost for nothing. It must fall
    // through to the paid path instead, where the caller gets a normal 402.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/app/api/x402/[service]/route.ts", import.meta.url), "utf8");
    const branch = src.slice(src.indexOf("const free = await consumeFree"));
    const degradedAt = branch.indexOf("} else if (free.degraded) {");
    const previewAt = branch.indexOf("const params = paramsFrom(req, service);");
    expect(degradedAt, "the degraded case must be handled").toBeGreaterThan(-1);
    expect(degradedAt, "and must be caught BEFORE the preview branch").toBeLessThan(previewAt);
    // The degraded branch body must not run the handler or return a preview.
    const body = branch.slice(degradedAt, previewAt);
    expect(body).not.toMatch(/service\.handler/);
    expect(body).not.toMatch(/previewBody|loadPreview/);
  });

  it("rateLimitKv falls back to the in-memory limiter instead of failing open", async () => {
    const { rateLimit } = await freshModules();
    const key = `k-${Math.random()}`;
    // In-memory fallback still enforces the limit within this instance.
    expect((await rateLimit.rateLimitKv(key, 2, 60)).ok).toBe(true);
    expect((await rateLimit.rateLimitKv(key, 2, 60)).ok).toBe(true);
    expect((await rateLimit.rateLimitKv(key, 2, 60)).ok).toBe(false);
  });
});

describe("KV rate-limited → an error body with HTTP 200 is a failure, not an empty value", () => {
  // Upstash answered a rate-limited database with HTTP 200 and
  // {"error":"Your database has been temporarily rate-limited, …"}. Reading the
  // status alone made every write look successful and every read look empty.
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function rateLimitedKv() {
    vi.resetModules();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://kv.test.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Your database has been temporarily rate-limited" }), { status: 200 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    return await import("@/lib/kv");
  }

  it("counters return null so money and quota guards fail closed", async () => {
    const kv = await rateLimitedKv();
    expect(await kv.kvIncrBy("k", 1)).toBeNull();
    expect(await kv.kvDecrBy("k", 1)).toBeNull();
    expect(await kv.kvIncr("k")).toBeNull();
  });

  it("a reservation is not granted", async () => {
    const kv = await rateLimitedKv();
    expect(await kv.kvSetNx("k", 60)).toBe(false);
  });

  it("the free tier still fails open (degraded) under a rate-limited KV", async () => {
    // Same fail-open path as a hard outage: the first try is granted from the
    // in-memory cap and flagged degraded, while money guards above return null.
    await rateLimitedKv();
    process.env.FREE_TIER_DAILY = "1";
    const freeTier = await import("@/lib/free-tier");
    const r = await freeTier.consumeFree(`ip-${Math.random()}`);
    expect(r.allowed).toBe(true);
    expect(r.degraded).toBe(true);
  });
});
