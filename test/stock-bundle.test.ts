import { describe, it, expect } from "vitest";
import { viewB20 } from "@/lib/pre-trade-bundle";

// 2026-10-17, owner-approved: a recognised regulated issuer's B20 powers are
// context. Measured before: every Coinbase stock was STOP in the bundle.
describe("bundle view of a regulated B20 stock", () => {
  const base = { address: "0xb2", isB20: true, variant: "asset", symbol: "NVDAc", wallet: null, walletStatus: null, observedRisks: [], powers: { seizable: true } };

  it("a GO with issuerControls is clean, and names the powers", () => {
    const v = viewB20({ ...base, decision: "GO", regulatedIssuer: { label: "Coinbase", policyAdmin: "0xec0f" }, issuerControls: ["issuer can blocklist + burnBlocked() SEIZE your balance"] } as never);
    expect(v.status).toBe("clean");
    expect(v.reason).toMatch(/regulated issuer.*SEIZE/);
  });

  it("an unrecognised issuer with seize power stays STOP", () => {
    const v = viewB20({ ...base, decision: "STOP", observedRisks: ["issuer can blocklist + burnBlocked() SEIZE your balance"] } as never);
    expect(v.status).toBe("stop");
  });
});
