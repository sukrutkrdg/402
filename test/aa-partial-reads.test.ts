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
    // "Nothing found" only means "not a smart account" if we looked everywhere.
    expect(body).toMatch(/verdict: blind \? "unknown" : "not_smart_account"/);
    expect(body).toMatch(/smartAccount: blind \? null : false/);
    expect(body, "the recommendation must say what was missed").toMatch(/could not be read/);
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
