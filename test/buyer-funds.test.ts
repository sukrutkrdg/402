import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { LOW_BALANCE_USD } from "@/lib/buyer-funds";

/**
 * `buyer-funds` sat in ALERT_KINDS for weeks with nothing raising it.
 *
 * Not a detector that went unread — a detector that was never written, with
 * only its name in place. The buyer wallet ran dry after the 03:00 run on
 * 2026-09-21; the runs on the 22nd and 23rd settled nothing and reported
 * `refreshed: 0` and `ok`, which is exactly what a morning looks like when
 * everything is already fresh. Two silent days.
 *
 * What it gates matters for how it is worded: this wallet is ours, so customers
 * paying from their own wallets are unaffected. It gates the keepalive, and
 * therefore discovery, which decays over about thirty days. A slow
 * disappearance, not an outage — which is why it needs an alarm rather than a
 * dashboard nobody opens.
 */
const lib = readFileSync("src/lib/buyer-funds.ts", "utf8");
const cron = readFileSync("src/app/api/cron/index-all/route.ts", "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("buyer funds", () => {
  it("warns with a run in hand, not at the moment it stops working", () => {
    // A run can spend the 60c cap plus one deliberately exempted over-cap
    // purchase; the dearest service is 75c, so $1.35 is one morning's worst case.
    expect(LOW_BALANCE_USD).toBeGreaterThan(1.35);
  });

  it("separates 'cannot settle anything' from 'running low'", () => {
    const code = strip(lib);
    expect(code).toMatch(/const empty = usdc < 0\.002/);
    expect(code).toMatch(/const low = usdc < LOW_BALANCE_USD/);
  });

  it("treats a failed read as unknown, never as empty", () => {
    // Raising an incident from a failed RPC call would be the false alarm this
    // exists to avoid — the same guard index-gap uses for a degraded sweep.
    expect(strip(lib)).toMatch(/catch\s*\{[\s\S]{0,60}return null/);
  });

  it("is actually raised, which is the whole point", () => {
    const code = strip(cron);
    expect(code).toMatch(/alertOwner\(\s*"buyer-funds"/);
    expect(code).toMatch(/clearAlert\(\s*"buyer-funds"/);
  });

  it("asks before spending, so a run that cannot pay says so", () => {
    const code = strip(cron);
    const check = code.indexOf("checkBuyerFunds()");
    const spend = code.indexOf("await pay(");
    expect(check).toBeGreaterThan(0);
    expect(spend).toBeGreaterThan(check);
  });

  /**
   * The wording has to be right or it produces the wrong panic. An empty buyer
   * wallet is not "the site is down" — nothing customer-facing is affected.
   */
  it("says plainly that customers are unaffected", () => {
    expect(lib).toMatch(/customers paying from their own wallets are unaffected/i);
    expect(lib).toMatch(/thirty days/i);
  });
});
