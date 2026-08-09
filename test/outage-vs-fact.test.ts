import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { classifyCode } from "../src/lib/primitives";

const src = (p: string) => readFileSync(new URL(`../src/lib/${p}`, import.meta.url), "utf8");

/**
 * An outage is not a fact, and code is no longer a contract.
 *
 * Two assumptions had spread across the handlers, and both produce answers that
 * look completely ordinary while being about the wrong thing — the worst shape a
 * paid answer can take, because the buyer has no way to tell.
 */
describe("a reading we could not take is never answered as a fact", () => {
  it("rug-monitor separates 'feed is down' from 'the pool is gone'", () => {
    // fetchLiquidity used to throw for BOTH, and every caller swallowed the throw
    // identically — so a token whose LP had been pulled entirely (nothing left to
    // index) came back as verdict "ok", note "liquidity still above the drop
    // threshold". The one event the product exists to catch was the one event
    // that silenced it. No pool is a reading of zero, not a missing reading.
    const s = src("rug-monitor.ts");
    expect(s, "provider-down must be null, not a throw").toMatch(/if \(raw === null\) return null/);
    expect(s, "no pool must read as zero liquidity").toMatch(/if \(pairs\.length === 0\) return 0/);
    expect(s, "an unread check must not answer ok").toContain('"unknown"');
    expect(s, "and must say so").toMatch(/degraded: true/);
    // The cron must skip only the unreadable case, never the drained one.
    expect(s).toMatch(/if \(current === null\) continue;/);
  });

  it("token-risk does not call a token non-standard when the chain was unreachable", () => {
    // Four parallel eth_calls on the public RPC hit its rate limiter and come
    // back 502; every read returned undefined, isErc20 went false, and the answer
    // asserted flags ["not_standard_erc20"], riskScore 40, degraded false — about
    // USDC. The reads are batched now, and total silence is treated as our
    // failure rather than a property of the token.
    const s = src("onchain.ts");
    expect(s, "reads must be batched into one round trip").toMatch(/baseTransport\(8000, true\)/);
    expect(s, "failures must be counted").toMatch(/readFailures\+\+/);
    expect(s, "all-silent must not produce the flag").toMatch(/!isErc20 && !rpcBlind/);
    expect(s, "and must not produce a risk band either").toMatch(/rpcBlind \? "unknown"/);
    expect(s).toMatch(/degraded: !securityChecked \|\| rpcBlind/);
  });
});

describe("EIP-7702: bytecode no longer means contract", () => {
  it("classifies a delegation pointer as an account", () => {
    // A delegating EOA carries exactly 23 bytes: 0xef0100 + the delegate address.
    const delegated = classifyCode("0xef0100" + "36d3cbd8b6d2d1b4d3f3e5c7a9b1d2e3f4a5b6c7");
    expect(delegated.isContract).toBe(false);
    expect(delegated.delegatedTo?.toLowerCase()).toBe("0x36d3cbd8b6d2d1b4d3f3e5c7a9b1d2e3f4a5b6c7");
    expect(classifyCode("0x").isContract).toBe(false);
    expect(classifyCode(undefined).isContract).toBe(false);
    expect(classifyCode("0x6080604052348015").isContract).toBe(true);
  });

  it("is used everywhere a contract check is made", () => {
    // Each of these read `code !== "0x"` and called a delegated wallet a
    // contract. On address-intel that also flips what the nonce MEANS —
    // eth_getTransactionCount counts transactions sent on an account that signs
    // and contracts created on a contract — so a wallet that had sent 1,326
    // transactions was reported as having deployed 1,326 contracts.
    for (const f of ["onchain.ts", "provenance.ts", "proxy.ts", "wallet-history.ts"]) {
      const s = src(f);
      expect(s, `${f} must use classifyCode`).toMatch(/classifyCode\(/);
      expect(s, `${f} still tests bytecode by hand`).not.toMatch(/code && code !== "0x"/);
    }
  });

  it("reports the nonce under the name that matches the account kind", () => {
    for (const f of ["onchain.ts", "wallet-history.ts"]) {
      const s = src(f);
      expect(s, `${f} must split sent vs deployed`).toMatch(/contractsDeployed/);
    }
    expect(src("onchain.ts")).toMatch(/eoa_delegated/);
    expect(src("wallet-history.ts")).toMatch(/accountType/);
  });

  it("treats a delegated upgrade admin as the single key it is", () => {
    // A delegated wallet admin was labelled "contract", which reads as governed
    // (multisig/timelock) when it is still one signing key that can swap the
    // logic at any block.
    const s = src("proxy.ts");
    expect(s).toMatch(/adminIsOneKey/);
    expect(s).toMatch(/adminType === "eoa" \|\| adminType === "eoa_delegated"/);
  });
});
