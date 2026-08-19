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

  it("consumeFree says WHY it denied, because the two reasons need opposite handling", async () => {
    // "You used today's call" earns a preview. "We could not count" must not —
    // see the route assertion below.
    const { freeTier } = await freshModules();
    const outage = await freeTier.consumeFree(`ip-${Math.random()}`);
    expect(outage.allowed).toBe(false);
    expect(outage.degraded).toBe(true);
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
