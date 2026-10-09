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

// weeks oldest→newest, each [transfers, senders, receivers]
function weeks(series: Array<[number, number, number]>) {
  sqlMock.cdpSql.mockResolvedValue(
    series.map((s, i) => ({ wk: `2026-09-0${i + 1} 00:00:00`, c: String(s[0]), sf: String(s[1]), st: String(s[2]) })),
  );
}

beforeEach(() => sqlMock.cdpSql.mockReset());

describe("activity-trend", () => {
  it("accelerating when activity rises toward a recent peak", async () => {
    weeks([[100, 40, 60], [200, 70, 110], [350, 120, 190], [500, 180, 260]]);
    const r = await activityTrend({ address: TOKEN });
    expect(r.verdict).toBe("accelerating");
    expect(r.weekOverWindowTrendPct).toBeGreaterThan(30);
  });

  it("dying when the latest week collapses vs the peak", async () => {
    weeks([[1000, 300, 400], [800, 250, 350], [200, 80, 120], [90, 30, 45]]);
    const r = await activityTrend({ address: TOKEN });
    expect(r.lastVsPeakPct).toBeLessThan(25);
    expect(r.verdict).toBe("dying");
  });

  it("cooling when the latest week is roughly half the peak", async () => {
    weeks([[1000, 300, 400], [900, 280, 380], [700, 220, 300], [450, 150, 200]]);
    const r = await activityTrend({ address: TOKEN });
    expect(r.verdict).toBe("cooling");
  });

  it("steady when activity holds near peak without a big rise", async () => {
    weeks([[500, 150, 200], [520, 160, 210], [490, 150, 205], [510, 155, 208]]);
    const r = await activityTrend({ address: TOKEN });
    expect(r.verdict).toBe("steady");
  });

  it("low_activity when there are only a handful of transfers", async () => {
    weeks([[2, 1, 2], [1, 1, 1], [3, 2, 2], [1, 1, 1]]);
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
