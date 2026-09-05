import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { entitledRawFrom, toShares } from "@/lib/stock-position";
import { WAD } from "@/lib/tokenized-stocks";
import { SERVICES } from "@/lib/services";

/**
 * The measured fact this endpoint is built on.
 *
 * B20 Asset tokens do not apply multiplier() to balanceOf(). Verified on chain:
 * token 0xb2000000000000000000000971c4062c121ca876 had its multiplier moved
 * 1.0 → 2.0 at block 50819308, and a holder's balanceOf read 100000000 both at
 * block 50819307 and at 50819309. The entitlement doubled and the number every
 * integrator displays did not move.
 *
 * Every one of Coinbase's thirteen equities reads 1.0 today, so nothing here is
 * exercised by production yet. It has to be right before the first one moves,
 * because that is the day every naive reader is silently wrong.
 */

const SHARE = 100_000_000n; // 1.0 share at 8 decimals

describe("the entitlement", () => {
  it("equals the raw balance while the multiplier is 1.0, which is every stock today", () => {
    expect(entitledRawFrom(SHARE * 100n, WAD)).toBe(SHARE * 100n);
  });

  it("doubles on a 2-for-1 split, the move actually observed on chain", () => {
    expect(entitledRawFrom(SHARE * 100n, WAD * 2n)).toBe(SHARE * 200n);
  });

  it("halves on a reverse split", () => {
    expect(entitledRawFrom(SHARE * 100n, WAD / 2n)).toBe(SHARE * 50n);
  });

  it("carries a 2% dividend adjustment — the scenario a portfolio app gets wrong", () => {
    // 100 shares, multiplier 1.00 → 1.02. balanceOf still says 100.
    const entitled = entitledRawFrom(SHARE * 100n, (WAD * 102n) / 100n);
    expect(toShares(entitled)).toBeCloseTo(102, 6);
  });

  /**
   * The division is last on purpose. Doing it in floating point would round a
   * fractional position and then multiply the error by the multiplier.
   */
  it("does not lose a fraction of a share on a real holding", () => {
    // METAc's actual supply on 2026-09-05: 2,976.885 shares.
    const raw = 297_688_500_000n;
    expect(entitledRawFrom(raw, WAD)).toBe(raw);
    expect(toShares(entitledRawFrom(raw, WAD * 4n))).toBeCloseTo(11907.54, 4);
  });

  it("returns zero for a zero balance rather than anything else", () => {
    expect(entitledRawFrom(0n, WAD * 4n)).toBe(0n);
  });
});

describe("what the response refuses to imply", () => {
  const src = readFileSync("src/lib/stock-position.ts", "utf8");

  /**
   * The most damaging wrong answer available: reporting an unreadable balance
   * as zero. "You hold nothing" and "we could not check" are opposite answers
   * and an RPC hiccup must never produce the first one.
   */
  it("treats an unreadable balance as unknown, never as empty", () => {
    expect(src).toMatch(/if \(raw === null\) \{[\s\S]{0,200}unreadable\.push/);
  });

  /**
   * A held token whose multiplier could not be read has an unknown entitlement.
   * Defaulting to 1.0 would be indistinguishable from a confirmed
   * no-corporate-action answer, which is the exact confusion this sells against.
   */
  it("does not assume a multiplier of 1.0 when it could not read one", () => {
    expect(src).toMatch(/if \(mult === null \|\| mult === 0n\)/);
    expect(src).not.toMatch(/mult \?\? WAD|mult \|\| WAD/);
  });

  it("declares every venue it does not cover, on every response", () => {
    for (const venue of ["uniswapV4Lp", "aerodromeLp", "aaveCollateral", "morphoCollateral", "eulerCollateral", "vaultShares"]) {
      expect(src).toMatch(new RegExp(`${venue}: false`));
    }
    // Published unconditionally — a caller must not have to notice its absence.
    expect(src).toMatch(/coverage: \{/);
    expect(src).not.toMatch(/\.\.\.\(.*\? \{ coverage/);
  });

  it("says the totals are a floor when a read failed", () => {
    expect(src).toMatch(/degraded: true, unreadable/);
  });
});

describe("the service is actually sellable", () => {
  const svc = SERVICES.find((s) => s.id === "stock-position");

  it("is registered in the catalogue", () => {
    expect(svc).toBeDefined();
  });

  it("asks for a wallet, not a token — the mistake that makes it unrunnable", () => {
    expect(svc?.params?.[0]?.name).toBe("wallet");
    expect(svc?.params?.[0]?.required).toBe(true);
  });

  it("is priced, since an unpriced service cannot settle and cannot be indexed", () => {
    expect(svc?.price).toMatch(/^\$\d/);
  });
});
