import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * "ok" is a claim about the market. It must never be a claim about our uptime.
 *
 * The poll path swallowed a failed price fetch, left `current` at null, and let
 * that fall through to `crossed === false` — which prints the same "ok" the
 * endpoint uses for "checked, and the threshold is not met". An agent polling
 * check=<id> to decide whether to act reads those identically, and the case it
 * gets wrong is precisely the dangerous one: the feed being down during a move
 * is when a price alert matters most.
 *
 * The house convention for this is already set by safe-to-send and rug-monitor:
 * an unread check is "unknown" with `degraded: true`, never a verdict.
 */
const { kvMock } = vi.hoisted(() => ({
  kvMock: {
    kvGet: vi.fn(),
    kvSet: vi.fn(),
    kvSAdd: vi.fn(),
    kvSRem: vi.fn(),
    kvSMembers: vi.fn(),
    kvConfigured: vi.fn(() => true),
  },
}));
vi.mock("@/lib/kv", () => kvMock);

import { registerAlert } from "@/lib/alerts";

const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ID = "alrt_abc123";

/** An active below-$1 alert on a token currently trading at $2. */
const alert = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: ID, token: TOKEN, threshold: 1, direction: "below", webhook: "",
    priceAtCreate: 2, createdAt: "2026-08-01T00:00:00.000Z", fired: false, ...over,
  });

const priceIs = (usd: number) =>
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ pairs: [{ baseToken: { address: TOKEN }, priceUsd: String(usd), liquidity: { usd: 1e6 } }] }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  kvMock.kvConfigured.mockReturnValue(true);
  kvMock.kvGet.mockResolvedValue(alert());
});
afterEach(() => vi.unstubAllGlobals());

describe("polling an alert while the price feed is down", () => {
  it("answers unknown, not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));
    const res = (await registerAlert({ check: ID })) as Record<string, unknown>;

    expect(res.verdict, "an outage is not a reading").toBe("unknown");
    expect(res.verdict).not.toBe("ok");
    expect(res.degraded).toBe(true);
    expect(res.currentPrice).toBeNull();
    // And the note has to say it too — an agent reading prose must not be told
    // the alert is quietly fine.
    expect(String(res.note)).toMatch(/could not be read/i);
    expect(String(res.note)).toMatch(/NOT a reading that the threshold was missed/i);
  });

  it("says ok only when a real price came back above the threshold", async () => {
    vi.stubGlobal("fetch", priceIs(2));
    const res = (await registerAlert({ check: ID })) as Record<string, unknown>;
    expect(res.verdict).toBe("ok");
    expect(res.degraded).toBe(false);
    expect(res.currentPrice).toBe(2);
  });

  it("still reports a crossing when the price is read", async () => {
    vi.stubGlobal("fetch", priceIs(0.5));
    const res = (await registerAlert({ check: ID })) as Record<string, unknown>;
    expect(res.verdict).toBe("THRESHOLD_MET");
    expect(res.degraded).toBe(false);
  });

  it("keeps FIRED through an outage, because that is our own record", async () => {
    // Whether it fired is durable state we wrote, not something the feed tells
    // us — downgrading it to unknown would lose a fact we actually hold.
    kvMock.kvGet.mockResolvedValue(alert({ fired: true, firedAt: "2026-08-02T00:00:00.000Z", firedPrice: 0.9 }));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));
    const res = (await registerAlert({ check: ID })) as Record<string, unknown>;
    expect(res.verdict).toBe("FIRED");
    expect(res.firedPrice).toBe(0.9);
  });

  it("an empty feed response is an outage too, not a missed threshold", async () => {
    // DexScreener answering 200 with no pairs reads as "no price data", which is
    // still us failing to take a reading — unlike rug-monitor, where an empty
    // pool genuinely means zero liquidity.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pairs: [] }) }));
    const res = (await registerAlert({ check: ID })) as Record<string, unknown>;
    expect(res.verdict).toBe("unknown");
    expect(res.degraded).toBe(true);
  });
});
