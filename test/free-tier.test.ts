import { describe, it, expect, beforeEach } from "vitest";
import { consumeFree } from "@/lib/free-tier";

// No UPSTASH/KV env is set in tests, so kv.ts uses its in-memory fallback,
// which persists within this process — enough to assert the accounting.
describe("consumeFree (1 free call per key per day)", () => {
  beforeEach(() => {
    process.env.FREE_TIER_DAILY = "1";
  });

  it("allows the first call and denies the second for the same key", async () => {
    const key = `test-${Math.random().toString(36).slice(2)}`;
    const first = await consumeFree(key);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(0);

    const second = await consumeFree(key);
    expect(second.allowed).toBe(false);
    expect(second.remaining).toBe(0);
  });

  it("tracks distinct keys independently", async () => {
    const a = await consumeFree(`a-${Math.random()}`);
    const b = await consumeFree(`b-${Math.random()}`);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });

  it("denies all calls when the daily limit is zero", async () => {
    process.env.FREE_TIER_DAILY = "0";
    const r = await consumeFree(`z-${Math.random()}`);
    expect(r.allowed).toBe(false);
  });
});
