import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Half a query is not half an answer here — it is a different answer.
 *
 * gasSponsor reads two EntryPoints and used to `continue` past whichever one
 * failed, keeping `dataAvailable` true because the other had replied. For a
 * wallet that operates only on the version that failed, the result was
 * verdict "not_smart_account" with the words "likely a plain EOA" — a flat
 * claim about the address, produced by not having looked. Where the wallet used
 * both, every count, percentage and gas total was quietly a floor.
 *
 * paymasterAudit had the mirror of it: when the concentration query failed,
 * `(top ?? [])` gave an empty list and topConcentrationPct fell to 0 — the
 * reassuring end of the scale. Concentration is the single number that turns a
 * healthy-looking paymaster into a one-app dependency, so reading 0 there is
 * the worst possible default.
 */
const src = readFileSync(new URL("../src/lib/aa.ts", import.meta.url), "utf8");
const bodyOf = (fn: string) => {
  const start = src.indexOf(`export async function ${fn}`);
  const next = src.indexOf("\nexport async function ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
};

describe("gasSponsor", () => {
  const body = bodyOf("gasSponsor");

  it("remembers which EntryPoint it could not read", () => {
    expect(body).toMatch(/unreadEntryPoints\.push\(`v\$\{ep\.v\}`\)/);
  });

  it("will not call an address a plain EOA on the strength of a partial look", () => {
    // "Nothing found" only means "not a smart account" if we looked everywhere,
    // and there are now two ways of not having: an EntryPoint that failed, and
    // EIP-8130, an account class this read cannot observe at all.
    expect(body).toMatch(/verdict: blind \? "unknown" : cannotRuleOut8130 \? "not_erc4337" : "not_smart_account"/);
    expect(body).toMatch(/smartAccount: blind \|\| cannotRuleOut8130 \? null : false/);
    expect(body, "the recommendation must say what was missed").toMatch(/could not be read/);
  });

  it("treats an unknown 8130 status as 'cannot rule out', never as 'not live'", () => {
    // nativeAaLive() returns null when its own probe failed. `!== false` is what
    // makes null fall on the cautious side; `=== true` would quietly restore the
    // confident-EOA answer on exactly the runs where we knew least.
    expect(body).toMatch(/cannotRuleOut8130 = nativeAa !== false/);
  });

  it("keeps 'likely a plain EOA' to one branch, and denies it in the other", () => {
    // The phrase is the whole risk: it is a claim about the address, not about
    // what we looked at. It may survive only on the path where 8130 is known
    // not to be live, so it must appear exactly once and the other path must
    // say the opposite in as many words.
    // Comments stripped: the source explains the hazard by naming the phrase,
    // and counting those would measure the prose instead of the behaviour.
    const code = body.replace(/^\s*\/\/.*$/gm, "");
    expect(code.match(/likely a plain EOA/g) ?? []).toHaveLength(1);
    expect(code).toMatch(/NOT a finding that the address is a plain EOA/);
  });

  it("labels its own coverage, so a caller knows what the percentages exclude", () => {
    expect(body).toMatch(/coverage: "erc-4337 EntryPoint v0\.6\+v0\.7 only"/);
  });

  it("marks a partial success path too, where the numbers are floors", () => {
    expect(body).toMatch(/degraded: unreadEntryPoints\.length > 0/);
    expect(body).toMatch(/PARTIAL: EntryPoint/);
  });
});

describe("paymasterAudit", () => {
  const body = bodyOf("paymasterAudit");

  it("reports unknown concentration as null, never as zero", () => {
    expect(body).toMatch(/const topUnread = top === null/);
    expect(body).toMatch(/concentrationPct = topUnread \? null/);
  });

  it("does not let a null slip into the >= 80 comparison", () => {
    // `null >= 80` is false, so the single-app warning would simply vanish.
    expect(body).toMatch(/concentrationPct !== null && concentrationPct >= 80/);
  });

  it("says outright that a one-app dependency has not been ruled out", () => {
    expect(body).toMatch(/nothing here rules out/i);
    expect(body).toMatch(/unreadSignals/);
  });
});

/**
 * EIP-8130 is not a degraded read — it is a blind spot.
 *
 * Cobalt accounts send ordinary type-0x79 transactions and name their gas payer
 * in a transaction field. No EntryPoint, no UserOperationEvent, and no paymaster
 * contract at all. Everything in aa.ts queries UserOperationEvents, so those
 * accounts are invisible to it however well the queries run. The failure this
 * guards is answering "not a smart account, likely a plain EOA" about an address
 * that is demonstrably a smart account on the other surface.
 */
describe("EIP-8130 coverage", () => {
  it("probes for the native-AA transaction type rather than assuming a date", () => {
    // Measured on vibenet, where 8130 is live: type 0x79 = 121. Base mainnet
    // serves types 0, 1, 2, 4 and 126 today, so the probe reads false — and it
    // will flip on its own the day Cobalt activates, with no redeploy.
    expect(src).toMatch(/NATIVE_AA_TX_TYPE = 121/);
    expect(src).toMatch(/FROM base\.transactions WHERE type = \$\{NATIVE_AA_TX_TYPE\}/);
  });

  it("returns null when the probe itself fails, so callers cannot read it as 'not live'", () => {
    expect(src).toMatch(/if \(rows === null\) return null;/);
  });

  it("does not cache a failed probe", () => {
    // Caching null would freeze the blind spot shut for the whole TTL.
    const fn = src.slice(src.indexOf("export async function nativeAaLive"));
    expect(fn.indexOf("return null;")).toBeLessThan(fn.indexOf("nativeAaCache = {"));
  });

  it("tells a paymaster caller that 8130 payers are not contracts", () => {
    expect(src).toMatch(/no paymaster contracts/);
  });

  it("says so in the notes, which is where an agent reads scope from", () => {
    expect(src).toMatch(/Does NOT cover EIP-8130 native accounts/);
    expect(src).toMatch(/Does NOT cover EIP-8130 payers/);
  });
});
