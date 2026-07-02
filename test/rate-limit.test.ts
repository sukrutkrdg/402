import { describe, it, expect } from "vitest";
import { rateLimit, rateLimitKv } from "@/lib/rate-limit";

describe("rateLimit (in-memory sliding window)", () => {
  it("allows up to the limit then blocks", () => {
    const key = `t-${Math.random()}`;
    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
    const blocked = rateLimit(key, 2, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("rateLimitKv (falls back to in-memory without KV)", () => {
  it("enforces the limit through the fallback path", async () => {
    const key = `k-${Math.random()}`;
    expect((await rateLimitKv(key, 2, 60)).ok).toBe(true);
    expect((await rateLimitKv(key, 2, 60)).ok).toBe(true);
    expect((await rateLimitKv(key, 2, 60)).ok).toBe(false);
  });
});
