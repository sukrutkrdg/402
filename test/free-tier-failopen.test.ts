import { describe, it, expect, beforeEach, vi } from "vitest";

// Simulate a degraded KV (outage / free-quota exhausted): kvIncr returns null.
// The free tier must then FAIL OPEN via its in-memory fallback — granting a real
// agent its free try rather than denying every caller a 402 — while the
// per-instance cap still bounds it so an outage can't open an unlimited tier.
vi.mock("@/lib/kv", () => ({
  kvIncr: vi.fn(async () => null),
  kvGetNumber: vi.fn(async () => 0),
}));

import { consumeFree } from "@/lib/free-tier";

describe("free tier fails OPEN when KV cannot count", () => {
  beforeEach(() => {
    process.env.FREE_TIER_DAILY = "1";
  });

  it("still grants the first free call from the in-memory fallback", async () => {
    const key = `failopen-${Math.random().toString(36).slice(2)}`;
    const first = await consumeFree(key);
    expect(first.allowed).toBe(true); // not denied — conversion preserved
    expect(first.degraded).toBe(true); // but the route still knows KV was down
  });

  it("still caps per instance per day (no unlimited free tier)", async () => {
    const key = `failopen-${Math.random().toString(36).slice(2)}`;
    expect((await consumeFree(key)).allowed).toBe(true);
    expect((await consumeFree(key)).allowed).toBe(false); // over the limit of 1
  });
});
