import { describe, it, expect } from "vitest";
import { judgeEstablished, ESTABLISHED_HOLDERS, ESTABLISHED_LIQUIDITY_USD, ADMIN_FLAGS } from "@/lib/established";

/**
 * Established tokens: admin controls are context, not risk. The rule must need
 * BOTH signals — holder counts alone are what airdrop spam fakes.
 */
describe("judgeEstablished", () => {
  it("needs both holders and liquidity", () => {
    expect(judgeEstablished(ESTABLISHED_HOLDERS, ESTABLISHED_LIQUIDITY_USD).established).toBe(true);
    expect(judgeEstablished(5_000_000, 50_000).established).toBe(false); // airdrop spam: many holders, no market
    expect(judgeEstablished(1_000, 50_000_000).established).toBe(false);
  });

  it("a missing signal is never established — strict scoring stays", () => {
    const r = judgeEstablished(null, 10_000_000);
    expect(r.established).toBe(false);
    expect(r.basis).toMatch(/unavailable/);
    expect(judgeEstablished(1_000_000, null).established).toBe(false);
  });

  it("is never applied over a disqualifying flag", () => {
    const r = judgeEstablished(1_000_000, 50_000_000, ["honeypot"]);
    expect(r.established).toBe(false);
    expect(r.basis).toMatch(/honeypot/);
  });

  it("demotes admin controls only — never a honeypot, tax, pause or hidden owner", () => {
    expect([...ADMIN_FLAGS].sort()).toEqual(["lp_not_locked", "mintable", "owner_not_renounced", "upgradeable_proxy"]);
  });
});
