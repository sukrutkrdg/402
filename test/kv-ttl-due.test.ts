import { describe, it, expect, vi, afterEach } from "vitest";
import { ttlDue } from "@/lib/kv";

/**
 * EXPIRE is re-sent at most once per half-TTL per instance — the saving that
 * keeps analytics inside the Upstash command budget — but always again before
 * the TTL could lapse, so no key can end up without one.
 */
describe("ttlDue", () => {
  afterEach(() => vi.useRealTimers());

  it("sends the first time, then skips until half the TTL has passed", () => {
    vi.useFakeTimers();
    const key = `k-${Math.random()}`;
    expect(ttlDue(key, 60)).toBe(true);
    expect(ttlDue(key, 60)).toBe(false);
    vi.advanceTimersByTime(29_000);
    expect(ttlDue(key, 60)).toBe(false);
    vi.advanceTimersByTime(2_000); // 31s > 30s = half of 60s
    expect(ttlDue(key, 60)).toBe(true);
  });

  it("re-sends a long TTL at least hourly", () => {
    vi.useFakeTimers();
    const key = `day-${Math.random()}`;
    expect(ttlDue(key, 8 * 86400)).toBe(true);
    vi.advanceTimersByTime(59 * 60_000);
    expect(ttlDue(key, 8 * 86400)).toBe(false);
    vi.advanceTimersByTime(2 * 60_000);
    expect(ttlDue(key, 8 * 86400)).toBe(true);
  });
});
