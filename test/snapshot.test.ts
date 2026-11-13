import { describe, it, expect, beforeEach, vi } from "vitest";
import { snapshot, resetSnapshots } from "@/lib/snapshot";

describe("snapshot", () => {
  beforeEach(() => resetSnapshots());

  it("coalesces reads within the TTL — one call, however many askers", async () => {
    const fn = vi.fn(async () => 1);
    const a = await snapshot("k", 1000, fn);
    const b = await snapshot("k", 1000, fn);
    expect(a.value).toBe(1);
    expect(b.value).toBe(1);
    expect(a.stale).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("serves the last good value, marked stale, when a refresh fails", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n === 1) return "good";
      throw new Error("KV down");
    });
    const first = await snapshot("k", 0, fn); // ttl 0 → always refresh
    expect(first).toEqual(expect.objectContaining({ value: "good", stale: false }));
    const second = await snapshot("k", 0, fn); // refresh throws
    expect(second.value).toBe("good");
    expect(second.stale).toBe(true);
  });

  it("rethrows only when there is no previous snapshot to fall back on", async () => {
    const fn = vi.fn(async () => {
      throw new Error("KV down");
    });
    await expect(snapshot("cold", 1000, fn)).rejects.toThrow(/KV down/);
  });

  it("shares one in-flight refresh across concurrent callers", async () => {
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    });
    const [a, b] = await Promise.all([snapshot("k", 1000, fn), snapshot("k", 1000, fn)]);
    expect(a.value).toBe(42);
    expect(b.value).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
