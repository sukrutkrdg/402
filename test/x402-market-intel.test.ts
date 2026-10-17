import { describe, it, expect, vi, afterEach } from "vitest";
import { x402MarketIntel } from "@/lib/x402-market-intel";

afterEach(() => vi.restoreAllMocks());

describe("x402-market-intel", () => {
  it("asks the index for at most 20 results (its maximum; 200 is refused with a 400)", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ resources: [] }) } as Response);
    await x402MarketIntel({ query: "token safety" });
    expect(String(spy.mock.calls[0][0])).toMatch(/[?&]limit=20(&|$)/);
  });

  it("refuses, not charged, when the index cannot be read — unknown is not an answer", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 400, json: async () => ({}) } as Response);
    await expect(x402MarketIntel({ query: "token safety" })).rejects.toThrow(/not charged/);
  });
});
