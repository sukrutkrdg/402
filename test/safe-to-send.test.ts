import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `safe-to-send` answers the question with the most abandoned buyers on the
 * network: address / counterparty screening had 724 distinct payers against
 * 1,755 calls in 30 days — more buyers than token-safety and less than a third
 * of the repeat use. People try it and do not come back.
 *
 * The shape is the product, so the shape is what is locked here. Reading source
 * rather than importing: the handler pulls in server-only upstreams.
 */
const src = readFileSync(new URL("../src/lib/safe-to-send.ts", import.meta.url), "utf8");
const services = readFileSync(new URL("../src/lib/services.ts", import.meta.url), "utf8");

describe("safe-to-send", () => {
  it("never returns GO on a check that did not run", () => {
    // The whole reason to trust this endpoint. A screen that failed must not
    // borrow confidence from the screens that succeeded — an unscreened
    // counterparty reading as clean is the one outcome that would be worse than
    // returning nothing at all.
    expect(src).toMatch(/const verdict = critical\.length > 0 \? "STOP" : unknown\.length > 0 \|\| caution\.length > 0 \? "REVIEW" : "GO"/);
  });

  it("reports what it skipped, and why", () => {
    // A factor we did not run and a factor that came back clean must never look
    // the same to the caller.
    expect(src).toMatch(/level: "skipped", reason: "not checked — the sanctions hit already decides this"/);
    expect(src).toMatch(/level: "skipped", reason: "not applicable — the recipient is a wallet, not a contract"/);
    expect(src).toMatch(/level: "skipped", reason: "not applicable — Coinbase verification and Basenames attach to user accounts/);
  });

  it("stops the moment sanctions hit, without paying for the slow reads", () => {
    expect(src).toMatch(/if \(factors\.sanctions\.level === "critical"\)/);
    // The early return must come before the archive lookup, not after it.
    const stop = src.indexOf('factors.sanctions.level === "critical"');
    const slow = src.indexOf("firstAppearance(address)");
    expect(stop).toBeGreaterThan(-1);
    expect(slow).toBeGreaterThan(stop);
  });

  it("does not mistake a delegated wallet for a contract", () => {
    // Since EIP-7702 a wallet carries code and still signs for itself. Calling
    // one a contract would put a "sending here can lose your funds" caution on
    // every Base App smart wallet.
    expect(src).toMatch(/classifyCode/);
    expect(src).toMatch(/type: "eoa_delegated"/);
    expect(src).not.toMatch(/code !== "0x"/);
  });

  it("is registered, cheap, and describes the moment of use", () => {
    const entry = services.slice(services.indexOf('id: "safe-to-send"'), services.indexOf('id: "safe-to-send"') + 1200);
    expect(entry).toMatch(/price: "\$0\.01"/);
    // Naming the moment of use is the one description feature measured to move
    // the ≥3-payer rate (17.6% vs 9.3% across the index).
    expect(entry).toMatch(/Before your agent sends, approves or signs/);
    const desc = entry.match(/description:\s*\n\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
    expect([...JSON.parse(`"${desc}"`)].length, "description must stay under the settle limit").toBeLessThan(500);
  });
});
