import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A crawler that reads a 402 price and leaves is still COUNTED — call totals and
 * challenge→paid conversion stay exact — but it is kept out of the per-day
 * source sets and the recent feed, which saves Upstash commands on the largest
 * traffic class. Everything else logs exactly as before.
 */
const { pipeline } = vi.hoisted(() => ({ pipeline: vi.fn(async (_c: (string | number)[][]) => [] as unknown[]) }));
vi.mock("@/lib/kv", () => ({
  kvConfigured: () => true,
  kvPipeline: pipeline,
  ttlDue: () => false,
  kvIncr: vi.fn(),
  kvGetNumber: vi.fn(),
  kvGetNumberStable: vi.fn(),
  kvLPush: vi.fn(),
  kvLRange: vi.fn(),
  kvSAdd: vi.fn(),
  kvSMembers: vi.fn(),
  kvHIncrBy: vi.fn(),
  kvHGetAll: vi.fn(),
}));

import { logUsage } from "@/lib/usage";

const BOT = "Mozilla/5.0 (compatible; Googlebot/2.1)";
const BROWSER = "Mozilla/5.0 (Windows NT 10.0) Chrome/130";
const ops = () => pipeline.mock.calls[0][0].map((c) => `${c[0]} ${c[1]}`);

describe("logUsage — slim record for bot 402 probes", () => {
  beforeEach(() => pipeline.mockClear());
  afterEach(() => vi.unstubAllEnvs());

  it("still counts a bot challenge, but skips the source sets and the recent feed", async () => {
    await logUsage("token-risk", false, "src1", BOT, "", false, false, true);
    const o = ops();
    expect(o).toEqual(expect.arrayContaining(["INCR usage:total:token-risk", "INCR usage:calls:total", "INCR usage:challenge:token-risk"]));
    expect(o.some((x) => x.startsWith("INCR usage:day:"))).toBe(true);
    expect(o.some((x) => x.startsWith("SADD") || x.startsWith("LPUSH") || x.startsWith("LTRIM"))).toBe(false);
  });

  it("logs a browser challenge in full", async () => {
    await logUsage("token-risk", false, "src1", BROWSER, "", false, false, true);
    expect(ops()).toEqual(expect.arrayContaining(["LPUSH usage:recent", "INCR usage:challenge:token-risk"]));
    expect(ops().some((x) => x.startsWith("SADD usage:src:"))).toBe(true);
  });

  it("logs a bot's PAID call in full — only price probes are slimmed", async () => {
    await logUsage("token-risk", true, "src1", BOT, "");
    expect(ops()).toEqual(expect.arrayContaining(["LPUSH usage:recent", "INCR usage:paid:token-risk"]));
    expect(ops().some((x) => x.startsWith("SADD usage:botsrc:"))).toBe(true);
  });

  it("USAGE_SLIM_BOT_CHALLENGES=false restores the full record", async () => {
    vi.stubEnv("USAGE_SLIM_BOT_CHALLENGES", "false");
    await logUsage("token-risk", false, "src1", BOT, "", false, false, true);
    expect(ops()).toEqual(expect.arrayContaining(["LPUSH usage:recent"]));
    expect(ops().some((x) => x.startsWith("SADD usage:botsrc:"))).toBe(true);
  });
});
