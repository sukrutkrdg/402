import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * KV outage behavior: when KV IS configured but unreachable (quota exhausted,
 * network down), money/quota guards must FAIL CLOSED — a KV outage must never
 * open an unlimited free tier or disable rate limiting entirely.
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

  it("consumeFree denies the free call during a KV outage", async () => {
    const { freeTier } = await freshModules();
    const r = await freeTier.consumeFree(`ip-${Math.random()}`);
    expect(r.allowed).toBe(false);
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
