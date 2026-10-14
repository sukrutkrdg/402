import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
const hashes = new Map<string, Record<string, number>>();
const sets = new Map<string, Set<string>>();
vi.mock("@/lib/kv", () => ({
  kvConfigured: () => true,
  kvGet: vi.fn(async (k: string) => store.get(k) ?? null),
  kvSet: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  kvIncrBy: vi.fn(async (k: string, by: number) => {
    const n = Number(store.get(k) ?? 0) + by;
    store.set(k, String(n));
    return n;
  }),
  kvHIncrBy: vi.fn(async (k: string, f: string, by = 1) => {
    const h = hashes.get(k) ?? {};
    h[f] = (h[f] ?? 0) + by;
    hashes.set(k, h);
  }),
  kvHGetAll: vi.fn(async (k: string) => hashes.get(k) ?? {}),
  kvSAdd: vi.fn(async (k: string, m: string) => void (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(m)),
  kvSMembers: vi.fn(async (k: string) => [...(sets.get(k) ?? [])]),
}));

const { recordExternalRevenue, externalLeaderboard, isOwnPayer } = await import("@/lib/keepalive-economics");

describe("external demand leaderboard", () => {
  beforeEach(() => {
    store.clear();
    hashes.clear();
    sets.clear();
  });

  it("ranks services by outside paid calls and counts distinct payers without storing addresses", async () => {
    const a = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
    const b = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
    await recordExternalRevenue(30, "token-risk", a);
    await recordExternalRevenue(30, "token-risk", b);
    await recordExternalRevenue(30, "token-risk", a);
    await recordExternalRevenue(50, "pre-trade-gate", a);

    const lb = await externalLeaderboard();
    expect(lb.services).toEqual([
      { id: "token-risk", calls: 3 },
      { id: "pre-trade-gate", calls: 1 },
    ]);
    expect(lb.externalCalls).toBe(4);
    expect(lb.distinctPayers).toBe(2);
    expect(lb.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify([...sets.values()].map((s) => [...s]))).not.toMatch(/aaaa|bbbb/i);
  });

  it("treats the owner's test wallet as ours", () => {
    expect(isOwnPayer("0xFe21a68f21d556A3C4274a44c2Fb5410c50cDa1C")).toBe(true);
    expect(isOwnPayer("0x1111111111111111111111111111111111111111")).toBe(false);
  });
});
