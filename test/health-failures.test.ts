import { describe, it, expect, vi } from "vitest";

const { lists } = vi.hoisted(() => ({ lists: new Map<string, string[]>() }));
vi.mock("@/lib/kv", () => ({
  kvHIncrBy: vi.fn(async () => undefined),
  kvHGetAll: vi.fn(async () => ({})),
  ttlDue: () => false,
  kvExpire: vi.fn(async () => undefined),
  kvLPush: vi.fn(async (k: string, v: string, cap = 200) => {
    lists.set(k, [v, ...(lists.get(k) ?? [])].slice(0, cap));
  }),
  kvLRange: vi.fn(async (k: string) => lists.get(k) ?? []),
}));

const { timed, readFailures, failureLine } = await import("@/lib/health");

/** /status said near-pre-trade-gate failed 17 of 97 calls a day and nothing said why. */
describe("failure reasons", () => {
  it("records our failures with the caller's message, never a 400, and scrubs URLs", async () => {
    await expect(timed("svc-a", async () => { throw new Error("Pools fetch failed (DexScreener unavailable) — not charged, retry shortly"); })).rejects.toThrow();
    await expect(timed("svc-a", async () => { throw new Error("Pools fetch failed (DexScreener unavailable) — not charged, retry shortly"); })).rejects.toThrow();
    await expect(timed("svc-a", async () => { throw new Error("Provide a valid 0x… token address"); })).rejects.toThrow();
    await expect(timed("svc-b", async () => { throw new Error("RPC Request failed. URL: https://base.example/v2/SECRETKEY body"); })).rejects.toThrow();
    const f = await readFailures();
    expect(f["svc-a"]).toEqual([expect.objectContaining({ reason: expect.stringMatching(/DexScreener unavailable/), count: 2 })]);
    expect(JSON.stringify(f)).not.toMatch(/valid 0x/);
    expect(f["svc-b"][0].reason).toContain("<upstream>");
    expect(JSON.stringify(f)).not.toContain("SECRETKEY");
  });

  it("caps a message at 160 characters", () => {
    expect((JSON.parse(failureLine("x", "y".repeat(500))) as { m: string }).m.length).toBe(160);
  });
});
