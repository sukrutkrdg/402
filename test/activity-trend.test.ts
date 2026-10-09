import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * activity-trend: weekly on-chain activity trajectory. CDP SQL is mocked so the
 * trend classification (accelerating / steady / cooling / dying / low_activity)
 * is what's under test.
 */
const { sqlMock } = vi.hoisted(() => ({ sqlMock: { cdpSql: vi.fn() } }));
vi.mock("@/lib/covalent", () => sqlMock);

import { activityTrend } from "@/lib/activity-trend";

const TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";

// weeks oldest→newest, each [transfers, receivers]. The query returns ONE row of
// rolling windows: c1/r1 = newest 7d … c4/r4 = oldest. So series[0]=oldest → c4.
function weeks(series: Array<[number, number]>) {
  const [w4, w3, w2, w1] = series; // oldest→newest maps to c4…c1
  sqlMock.cdpSql.mockResolvedValue([
    {
      c1: String(w1[0]), r1: String(w1[1]),
      c2: String(w2[0]), r2: String(w2[1]),
      c3: String(w3[0]), r3: String(w3[1]),
      c4: String(w4[0]), r4: String(w4[1]),
    },
  ]);
}

beforeEach(() => sqlMock.cdpSql.mockReset());

describe("activity-trend", () => {
  it("accelerating when activity rises toward a recent peak", async () => {
    weeks([[100, 60], [200, 110], [350, 190], [500, 260]]);
    const r = await activityTrend({ address: TOKEN });
    expect(r.verdict).toBe("accelerating");
    expect(r.weekOverWindowTrendPct).toBeGreaterThan(30);
  });

  it("dying when the latest week collapses vs the peak", async () => {
    weeks([[1000, 400], [800, 350], [200, 120], [90, 45]]);
    const r = await activityTrend({ address: TOKEN });
    expect(r.lastVsPeakPct).toBeLessThan(25);
    expect(r.verdict).toBe("dying");
  });

  it("cooling when the latest week is roughly half the peak", async () => {
    weeks([[1000, 400], [900, 380], [700, 300], [450, 200]]);
    const r = await activityTrend({ address: TOKEN });
    expect(r.verdict).toBe("cooling");
  });

  it("steady when activity holds near peak without a big rise", async () => {
    weeks([[500, 200], [520, 210], [490, 205], [510, 208]]);
    const r = await activityTrend({ address: TOKEN });
    expect(r.verdict).toBe("steady");
  });

  it("low_activity when there are only a handful of transfers", async () => {
    weeks([[2, 2], [1, 1], [3, 2], [1, 1]]);
    const r = await activityTrend({ address: TOKEN });
    expect(r.verdict).toBe("low_activity");
  });

  it("dormant when there is no activity at all", async () => {
    sqlMock.cdpSql.mockResolvedValue([]);
    const r = await activityTrend({ address: TOKEN });
    expect(r.verdict).toBe("dormant");
    expect(r.weeks).toEqual([]);
  });

  it("does not charge when the warehouse is unavailable", async () => {
    sqlMock.cdpSql.mockResolvedValue(null);
    await expect(activityTrend({ address: TOKEN })).rejects.toThrow(/not charged/);
  });
});
