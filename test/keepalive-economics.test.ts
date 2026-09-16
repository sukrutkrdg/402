import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Is staying in the discovery index worth what it costs?
 *
 * The keepalive settles payments from our buyer wallet into our seller wallet so
 * listings stay inside the Bazaar's rolling window. Those are real settlements
 * on chain and they land in revenue — our own money going in a circle. Measured
 * over the fourteen days to 2026-09-16: roughly $0.18/day out, $0.03/day in from
 * outside, and 13 of 161 services saw an external purchase at all.
 *
 * The obvious reading is to stop paying for the other 148, and it is the wrong
 * move today for a measurement reason rather than a sentimental one. Until
 * 2026-09-14 the catalogue published unusable examples for 107 of 159 required
 * parameters, eleven services were absent from discovery while reading as fresh,
 * and the CDN refused library clients. That fortnight measured a broken funnel,
 * not a market — and cutting discovery spend on it would guarantee the next
 * fortnight looked the same and "proved" the decision right.
 *
 * So this exists to make the decision arrive on its own, from a stated start
 * date, rather than to argue for either answer now.
 */
const { kvMock } = vi.hoisted(() => ({
  kvMock: {
    kvConfigured: vi.fn(),
    kvGet: vi.fn(),
    kvSet: vi.fn(),
    kvIncrBy: vi.fn(),
  },
}));
vi.mock("@/lib/kv", () => kvMock);

import { recordKeepaliveSpend, keepaliveEconomics } from "@/lib/keepalive-economics";

const DAY = 86_400_000;

describe("keepalive economics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvMock.kvConfigured.mockReturnValue(true);
    kvMock.kvGet.mockResolvedValue(null);
    kvMock.kvSet.mockResolvedValue(undefined);
    kvMock.kvIncrBy.mockResolvedValue(1);
  });

  it("records a settlement's cost and starts the clock on first sight", async () => {
    await recordKeepaliveSpend(3);
    expect(kvMock.kvSet).toHaveBeenCalledWith("keepalive:since", expect.any(String));
    expect(kvMock.kvIncrBy).toHaveBeenCalledWith("keepalive:spent:cents", 3);
    expect(kvMock.kvIncrBy).toHaveBeenCalledWith("keepalive:calls", 1);
  });

  it("never restarts the clock, or every reading has a different denominator", async () => {
    kvMock.kvGet.mockResolvedValue("2026-09-01T00:00:00.000Z");
    await recordKeepaliveSpend(3);
    expect(kvMock.kvSet).not.toHaveBeenCalledWith("keepalive:since", expect.any(String));
  });

  it("books nothing for a call that settled nothing", async () => {
    await recordKeepaliveSpend(0);
    await recordKeepaliveSpend(-5);
    await recordKeepaliveSpend(Number.NaN);
    expect(kvMock.kvIncrBy).not.toHaveBeenCalled();
  });

  /**
   * The whole point. Keepalive spend arrives as revenue, so counting it would
   * make the conveyor look like demand — the same error that had our own buyer
   * listed as a customer and a bridge delivery booked as a sale.
   */
  it("subtracts what we paid ourselves from what was settled", async () => {
    const at: Record<string, string> = {
      "keepalive:since": new Date(Date.now() - 20 * DAY).toISOString(),
      "keepalive:spent:cents": "250",
      "keepalive:calls": "140",
    };
    kvMock.kvGet.mockImplementation(async (k: string) => at[k] ?? null);
    const e = (await keepaliveEconomics(3.0))!;
    expect(e.spentUsd).toBe(2.5);
    expect(e.externalUsd, "settled 3.00 minus 2.50 we paid ourselves").toBe(0.5);
    expect(e.returnRatio).toBe(0.2);
    expect(e.settlements).toBe(140);
  });

  it("never reports negative external revenue when we outspend the take", async () => {
    const at: Record<string, string> = {
      "keepalive:since": new Date(Date.now() - 20 * DAY).toISOString(),
      "keepalive:spent:cents": "500",
      "keepalive:calls": "200",
    };
    kvMock.kvGet.mockImplementation(async (k: string) => at[k] ?? null);
    const e = (await keepaliveEconomics(1.0))!;
    expect(e.externalUsd).toBe(0);
    expect(e.returnRatio).toBe(0);
  });

  it("refuses to draw a conclusion before the window is long enough", async () => {
    const at: Record<string, string> = {
      "keepalive:since": new Date(Date.now() - 3 * DAY).toISOString(),
      "keepalive:spent:cents": "50",
      "keepalive:calls": "30",
    };
    kvMock.kvGet.mockImplementation(async (k: string) => at[k] ?? null);
    const e = (await keepaliveEconomics(0.6))!;
    expect(e.verdict).toMatch(/Too early/i);
    expect(e.verdict, "and it should say why, not just decline").toMatch(/2026-09-14|runnable examples/);
  });

  it("names the narrowing question once there is enough data to ask it", async () => {
    const at: Record<string, string> = {
      "keepalive:since": new Date(Date.now() - 30 * DAY).toISOString(),
      "keepalive:spent:cents": "600",
      "keepalive:calls": "360",
    };
    kvMock.kvGet.mockImplementation(async (k: string) => at[k] ?? null);
    const e = (await keepaliveEconomics(6.5))!;
    expect(e.verdict).not.toMatch(/Too early/i);
    expect(e.verdict).toMatch(/no external purchase/i);
  });

  it("says nothing rather than zero when there is no ledger", async () => {
    kvMock.kvConfigured.mockReturnValue(false);
    expect(await keepaliveEconomics(5)).toBeNull();
  });
});
