import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Who may hold Base's tokenized equities — the question every builder on top of
 * them has to answer, and the one nobody publishes.
 *
 * Base's Request for Builders names five categories (neobrokerages,
 * personalised indices, gifting, yield stripping, agents allocating on their
 * own) and repeats three times that these assets are for "eligible users in
 * permitted jurisdictions outside the United States". Every one of those
 * categories has to know whether a given address can hold the asset before it
 * builds a transaction that would revert.
 *
 * Measured on 2026-09-14 against AAPLc and AMZNc: both carry sender and receiver
 * policy id 5 — set, not the unset 0 that the registry treats as always-allow —
 * and `isAuthorized` answered true for every address tried, including a burn
 * address, a token contract, a DEX factory, and an EOA that has never existed.
 * Eligibility is therefore not enforced at transfer; it is enforced at issuance
 * and redemption inside Coinbase's own app.
 *
 * That is worth publishing, and it is exactly why it needs watching: it is a
 * POLICY, not a property. Its admin can change what id 5 authorises at any
 * block, and nothing about the token address, its ABI or its multiplier changes
 * to announce it — every integration built on today's permissiveness breaks at
 * once, silently.
 */

const lib = readFileSync("src/lib/tokenized-stocks.ts", "utf8");
const cron = readFileSync("src/app/api/cron/stock-actions/route.ts", "utf8");
const page = readFileSync("src/app/stocks/page.tsx", "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("transfer policy is read, not assumed", () => {
  it("asks the registry about a specific address, rather than inferring from the policy id", () => {
    expect(strip(lib)).toMatch(/functionName:\s*"isAuthorized"/);
    expect(strip(lib)).toMatch(/B20_POLICY_REGISTRY\s*=\s*"0x8453000000000000000000000000000000000002"/);
  });

  it("uses a canary with no relationship to us, so an allow-list cannot hide a tightening", () => {
    // Read from source rather than imported: this module pulls in `server-only`
    // and a viem client, and importing it here made the assertion depend on
    // module-loading order — it passed alone and failed in the full suite. The
    // property being pinned is about the constant's VALUE, which the text has.
    const m = strip(lib).match(/CANARY\s*=\s*"(0x[0-9a-fA-F]{40})"/);
    expect(m, "CANARY must be a literal address in tokenized-stocks.ts").toBeTruthy();
    const CANARY = m![1];
    // Our own wallets would be the obvious choice and the wrong one: if the
    // issuer ever allow-lists holders individually, a wallet of ours could pass
    // while everyone else is blocked, and the watch would report all-clear
    // through the exact event it exists to catch.
    const ours = [
      process.env.PAY_TO_ADDRESS ?? "",
      "0xfe21a68f21d556a3c4274a44c2fb5410c50cda1c", // buyer
    ].map((a) => a.toLowerCase());
    expect(ours).not.toContain(CANARY.toLowerCase());
  });

  /**
   * The same rule the multiplier watch already follows, for the same reason: a
   * network blip written back as the baseline means the real change that comes
   * after it compares equal and is never reported.
   */
  it("never writes a failed read as the baseline", () => {
    const code = strip(cron);
    expect(code).toMatch(/senderPolicyId === null \|\|[\s\S]{0,140}canaryMayReceive === null/);
    const guard = code.indexOf("canaryMayReceive === null");
    const write = code.indexOf("kvSet(POLICY_KEY");
    expect(guard, "the unread guard must come before any baseline write").toBeGreaterThan(0);
    expect(write).toBeGreaterThan(guard);
  });

  it("seeds first sight silently instead of alerting thirteen times on deploy", () => {
    expect(strip(cron)).toMatch(/if \(prev === null\)[\s\S]{0,120}seeded\+\+/);
  });

  it("raises its own incident kind, because the response differs from a multiplier move", async () => {
    const { ALERT_KINDS } = await import("@/lib/alert-owner");
    expect(ALERT_KINDS).toContain("stock-policy");
    expect(strip(cron)).toMatch(/alertOwner\(\s*"stock-policy"/);
  });

  /**
   * An unset policy slot (id 0) reads as always-allow. Collapsing that into the
   * same bucket as "a live policy that currently permits everyone" would erase
   * the distinction the whole finding rests on — one has no admin to change its
   * mind, the other does.
   */
  it("keeps 'no policy' apart from 'a policy that currently permits everyone'", () => {
    expect(strip(lib)).toMatch(/senderPolicyId !== null && r\.policy\.senderPolicyId !== "0"/);
  });

  it("states the measurement on the page, and never claims these are unrestricted", () => {
    expect(page).toMatch(/board\.transferPolicy/);
    expect(page).toMatch(/isAuthorized\(policyId, address\)/);
    // The claim we must not make.
    expect(page.toLowerCase()).not.toMatch(/anyone can (hold|buy|own) (them|these)/);
  });
});
