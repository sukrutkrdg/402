import { describe, it, expect, beforeEach } from "vitest";
import { consumeFree } from "@/lib/free-tier";

// No UPSTASH/KV env is set in tests, so kv.ts uses its in-memory fallback,
// which persists within this process — enough to assert the accounting.
describe("consumeFree (1 free call per key per day)", () => {
  beforeEach(() => {
    process.env.FREE_TIER_DAILY = "1";
  });

  it("allows the first call and denies the second for the same key", async () => {
    const key = `test-${Math.random().toString(36).slice(2)}`;
    const first = await consumeFree(key);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(0);

    const second = await consumeFree(key);
    expect(second.allowed).toBe(false);
    expect(second.remaining).toBe(0);
  });

  it("tracks distinct keys independently", async () => {
    const a = await consumeFree(`a-${Math.random()}`);
    const b = await consumeFree(`b-${Math.random()}`);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });

  it("denies all calls when the daily limit is zero", async () => {
    process.env.FREE_TIER_DAILY = "0";
    const r = await consumeFree(`z-${Math.random()}`);
    expect(r.allowed).toBe(false);
  });
});

/**
 * The credit ledger counts whole cents, so a sub-cent price must never round to
 * zero — that would hand every credit holder a permanently free service. This
 * pins the rounding rule that url-extract's $0.002 depends on.
 */
describe("priceCents (credit-ledger rounding)", () => {
  // Mirror of the helper in api/x402/[service]/route.ts.
  const priceCents = (price: string): number => {
    const usd = parseFloat(price.replace(/[^0-9.]/g, "")) || 0;
    if (usd <= 0) return 0;
    return Math.max(1, Math.ceil(usd * 100));
  };

  it("never charges zero for a sub-cent price", () => {
    expect(priceCents("$0.002")).toBe(1);
    expect(priceCents("$0.001")).toBe(1);
    expect(priceCents("$0.009")).toBe(1);
  });

  it("leaves whole-cent prices exactly as they are", () => {
    expect(priceCents("$0.01")).toBe(1);
    expect(priceCents("$0.03")).toBe(3);
    expect(priceCents("$0.75")).toBe(75);
    expect(priceCents("$5.00")).toBe(500);
  });

  it("rounds a fractional cent up rather than down", () => {
    expect(priceCents("$0.015")).toBe(2); // 1.5c -> 2, never 1
    expect(priceCents("$0.024")).toBe(3);
  });

  it("returns zero only for a genuinely zero price", () => {
    expect(priceCents("$0")).toBe(0);
    expect(priceCents("free")).toBe(0);
  });
});
