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

import { recordKeepaliveSpend, recordExternalRevenue, keepaliveEconomics } from "@/lib/keepalive-economics";

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
  it("reads external revenue from its own counter, not by subtraction", async () => {
    const at: Record<string, string> = {
      "keepalive:since": new Date(Date.now() - 20 * DAY).toISOString(),
      "keepalive:spent:cents": "250",
      "keepalive:calls": "140",
      "external:revenue:cents": "50",
      "external:calls": "18",
    };
    kvMock.kvGet.mockImplementation(async (k: string) => at[k] ?? null);
    const e = (await keepaliveEconomics())!;
    expect(e.circulatedUsd).toBe(2.5);
    expect(e.externalUsd).toBe(0.5);
    expect(e.externalCalls).toBe(18);
    expect(e.externalVsCirculated).toBe(0.2);
    expect(e.settlements).toBe(140);
  });

  /**
   * The bug this replaced: external was (settled in a ~11-hour block scan) minus
   * (circulated since the baseline). Different periods, so the answer was noise
   * — on 2026-09-22 it read $0 external over 5.1 days, three days after a wallet
   * paid $0.70 in one afternoon.
   */
  it("does not let circulated USDC reduce external revenue", async () => {
    const at: Record<string, string> = {
      "keepalive:since": new Date(Date.now() - 20 * DAY).toISOString(),
      "keepalive:spent:cents": "9999",
      "keepalive:calls": "500",
      "external:revenue:cents": "70",
      "external:calls": "18",
    };
    kvMock.kvGet.mockImplementation(async (k: string) => at[k] ?? null);
    const e = (await keepaliveEconomics())!;
    expect(e.externalUsd, "outside demand stands on its own").toBe(0.7);
  });

  it("books an outside settlement against the external counter only", async () => {
    await recordExternalRevenue(3);
    expect(kvMock.kvIncrBy).toHaveBeenCalledWith("external:revenue:cents", 3);
    expect(kvMock.kvIncrBy).toHaveBeenCalledWith("external:calls", 1);
    expect(kvMock.kvIncrBy).not.toHaveBeenCalledWith("keepalive:spent:cents", expect.anything());
  });

  it("reports zero external when nobody outside has paid", async () => {
    const at: Record<string, string> = {
      "keepalive:since": new Date(Date.now() - 20 * DAY).toISOString(),
      "keepalive:spent:cents": "500",
      "keepalive:calls": "200",
    };
    kvMock.kvGet.mockImplementation(async (k: string) => at[k] ?? null);
    const e = (await keepaliveEconomics())!;
    expect(e.externalUsd).toBe(0);
    expect(e.externalCalls).toBe(0);
    expect(e.externalVsCirculated).toBe(0);
  });

  it("refuses to draw a conclusion before the window is long enough", async () => {
    const at: Record<string, string> = {
      "keepalive:since": new Date(Date.now() - 3 * DAY).toISOString(),
      "keepalive:spent:cents": "50",
      "keepalive:calls": "30",
    };
    kvMock.kvGet.mockImplementation(async (k: string) => at[k] ?? null);
    const e = (await keepaliveEconomics())!;
    expect(e.verdict).toMatch(/Too early/i);
    expect(e.verdict, "and it should say why, not just decline").toMatch(/2026-09-14|runnable examples/);
  });

  /**
   * The keepalive USDC is not a cost and the verdict must not imply it is.
   * Verified on chain against the $1 credit pack (tx 0xddfb88cd…): exactly one
   * USDC Transfer log, buyer → seller, full amount, no facilitator cut, and gas
   * paid by the facilitator's own submitter. Both wallets are ours, so the money
   * goes in a circle. Calling it spend framed a question whose premise was false.
   */
  it("does not present circulated USDC as money we spent", async () => {
    const at: Record<string, string> = {
      "keepalive:since": new Date(Date.now() - 30 * DAY).toISOString(),
      "keepalive:spent:cents": "600",
      "keepalive:calls": "360",
    };
    kvMock.kvGet.mockImplementation(async (k: string) => at[k] ?? null);
    const e = (await keepaliveEconomics())!;
    expect(e.verdict).not.toMatch(/Too early/i);
    expect(e.verdict).toMatch(/circular/i);
    expect(e.verdict, "the real cost is upstream consumption, not the USDC").toMatch(/Anthropic|Exa/);
    expect(e.verdict).not.toMatch(/what we pay to be findable/i);
  });

  it("says nothing rather than zero when there is no ledger", async () => {
    kvMock.kvConfigured.mockReturnValue(false);
    expect(await keepaliveEconomics()).toBeNull();
  });
});
