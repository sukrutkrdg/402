import { describe, it, expect, vi, beforeEach } from "vitest";

const readContract = vi.fn();
const getBlock = vi.fn();

vi.mock("viem", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, createPublicClient: () => ({ readContract, getBlock }) };
});
vi.mock("@/lib/base-transport", () => ({ baseTransport: () => () => ({}) }));

import { oracleStaleness } from "@/lib/oracle-staleness";

const POOL = "0x6cdcb1c4a4d1c3c6d054b27ac5b77e89eafb971d";
const nowSec = Math.floor(Date.now() / 1000);
// slot0 tuple: [sqrtP, tick, observationIndex, cardinality, cardinalityNext, feeProtocol, unlocked]
const slot0 = (card: number, next = card, index = 0) => [1n, 0, index, card, next, 0, true] as const;
const obs = (ts: number) => [ts, 0n, 0n, true] as const;

beforeEach(() => {
  vi.clearAllMocks();
  getBlock.mockResolvedValue({ timestamp: BigInt(nowSec) });
});

describe("oracle-staleness", () => {
  it("rejects a bad address pre-settlement", async () => {
    await expect(oracleStaleness({ pool: "x" })).rejects.toThrow(/valid 0x/i);
  });

  it("returns degraded when slot0 is unreadable (not a V3 pool)", async () => {
    readContract.mockRejectedValueOnce(new Error("execution reverted"));
    const r = (await oracleStaleness({ pool: POOL })) as Record<string, any>;
    expect(r.verdict).toBe("unknown");
    expect(r.degraded).toBe(true);
  });

  it("calls a cardinality-1 pool UNUSABLE (observe would revert)", async () => {
    readContract
      .mockResolvedValueOnce(slot0(1)) // slot0
      .mockResolvedValueOnce(obs(nowSec)) // observations
      .mockResolvedValueOnce(BigInt(nowSec * 1000)); // BaseTime timestampMs
    const r = (await oracleStaleness({ pool: POOL })) as Record<string, any>;
    expect(r.verdict).toBe("unusable");
    expect(r.nowSource).toBe("basetime");
  });

  it("flags a current, deep buffer as HEALTHY", async () => {
    readContract
      .mockResolvedValueOnce(slot0(200))
      .mockResolvedValueOnce(obs(nowSec - 10)) // 10s ago
      .mockResolvedValueOnce(BigInt(nowSec * 1000));
    const r = (await oracleStaleness({ pool: POOL })) as Record<string, any>;
    expect(r.verdict).toBe("healthy");
    expect(r.observationCardinality).toBe(200);
  });

  it("flags a shallow buffer (low cardinality) as SHALLOW", async () => {
    readContract
      .mockResolvedValueOnce(slot0(10))
      .mockResolvedValueOnce(obs(nowSec - 5))
      .mockResolvedValueOnce(BigInt(nowSec * 1000));
    const r = (await oracleStaleness({ pool: POOL })) as Record<string, any>;
    expect(r.verdict).toBe("shallow");
    expect(r.flags.some((f: string) => /shallow oracle buffer/.test(f))).toBe(true);
  });

  it("flags an old newest-observation as STALE and reports the age", async () => {
    readContract
      .mockResolvedValueOnce(slot0(200))
      .mockResolvedValueOnce(obs(nowSec - 3 * 3600)) // 3h old
      .mockResolvedValueOnce(BigInt(nowSec * 1000));
    const r = (await oracleStaleness({ pool: POOL })) as Record<string, any>;
    expect(r.verdict).toBe("stale");
    expect(r.lastObservationAgeSeconds).toBeGreaterThanOrEqual(7200);
  });

  it("falls back to block timestamp when BaseTime is unavailable", async () => {
    readContract
      .mockResolvedValueOnce(slot0(200))
      .mockResolvedValueOnce(obs(nowSec - 5))
      .mockRejectedValueOnce(new Error("no BaseTime")); // timestampMs reverts
    const r = (await oracleStaleness({ pool: POOL })) as Record<string, any>;
    expect(r.nowSource).toBe("block");
    expect(r.verdict).toBe("healthy");
  });
});
