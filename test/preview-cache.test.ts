import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Preview cache — closes the unpaid-preview cost-drain. A repeat preview for the
 * same input must serve from KV without re-running the handler's upstreams, and
 * two different inputs must NOT collide (returning the wrong token's teaser).
 */
const { kvMock } = vi.hoisted(() => ({
  kvMock: { kvGet: vi.fn(), kvSet: vi.fn() },
}));
vi.mock("@/lib/kv", () => kvMock);

import { loadPreview, savePreview } from "@/lib/preview-cache";

const A = { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
const B = { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

describe("preview-cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kvMock.kvSet.mockResolvedValue(undefined);
  });

  it("round-trips a preview under a service+input key", async () => {
    kvMock.kvGet.mockResolvedValue(JSON.stringify({ riskScore: 42 }));
    const r = await loadPreview("token-risk", A);
    expect(r).toEqual({ riskScore: 42 });
  });

  it("uses distinct keys for different inputs (no wrong-token teaser)", async () => {
    await savePreview("token-risk", A, { riskScore: 1 });
    await savePreview("token-risk", B, { riskScore: 2 });
    const keyA = kvMock.kvSet.mock.calls[0][0];
    const keyB = kvMock.kvSet.mock.calls[1][0];
    expect(keyA).not.toBe(keyB);
    expect(keyA.startsWith("preview:token-risk:")).toBe(true);
  });

  it("keys identically regardless of param order", async () => {
    await savePreview("svc", { a: "1", b: "2" }, {});
    await savePreview("svc", { b: "2", a: "1" }, {});
    expect(kvMock.kvSet.mock.calls[0][0]).toBe(kvMock.kvSet.mock.calls[1][0]);
  });

  it("returns null on a cache miss and never throws on bad JSON", async () => {
    kvMock.kvGet.mockResolvedValue(null);
    expect(await loadPreview("svc", A)).toBeNull();
    kvMock.kvGet.mockResolvedValue("{not json");
    expect(await loadPreview("svc", A)).toBeNull();
  });

  it("writes with a short TTL (teaser freshness)", async () => {
    await savePreview("svc", A, { x: 1 });
    const ttl = kvMock.kvSet.mock.calls[0][2];
    expect(ttl).toBeLessThanOrEqual(300);
    expect(ttl).toBeGreaterThan(0);
  });
});
