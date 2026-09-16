import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Our own money must not read back to us as demand.
 *
 * The keepalive settles a dozen payments into the seller wallet every morning at
 * 03:00 — real x402 settlements, indistinguishable on chain from a customer's.
 * The payers dashboard excluded "our" wallets by consulting OWN_WALLETS, which
 * was set and did not contain the buyer. So on 2026-09-16 five of the day's six
 * payments and $0.06 of the $0.09 were counted as external demand.
 *
 * This is the same defect as the revenue scan two days earlier, in a different
 * place and for a different reason: there it counted a bridge delivery as a
 * sale, here it counts us as a customer. Both inflate the one number every
 * decision about this business is made against, and both were invisible because
 * the wrong figure looks exactly like a good day.
 *
 * The fix is to stop asking a list. The buyer address is derivable from the key
 * that signs the payments, so it cannot drift; an env var someone has to
 * remember is not a defence against forgetting.
 */
const route = readFileSync("src/app/api/payers/route.ts", "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = strip(route);

describe("payers separates our own settlements from customers'", () => {
  it("derives the buyer rather than trusting OWN_WALLETS to list it", () => {
    expect(code).toMatch(/getBuyerAddress\(\)/);
    expect(code).toMatch(/ourWallets\.add\(buyer\.toLowerCase\(\)\)/);
  });

  it("keeps the configured list as well, rather than replacing it", () => {
    expect(code).toMatch(/new Set\(cfg\.ownWallets\.map/);
  });

  it("judges every wallet against the derived set, not the raw config", () => {
    expect(code).toMatch(/ours:\s*ourWallets\.has\(/);
    expect(code, "the old check missed the buyer entirely").not.toMatch(/ours:\s*cfg\.ownWallets\.includes/);
  });

  it("compares lowercased, because chain rows and env vars disagree on case", () => {
    expect(code).toMatch(/ourWallets\.has\(w\.wallet\.toLowerCase\(\)\)/);
  });

  /**
   * Reported apart, never hidden: a dashboard that silently drops our own
   * spending tells a different lie from one that counts it as revenue, but it is
   * still a lie. The operator should be able to see both numbers.
   */
  it("still reports our own wallets, counted separately", () => {
    expect(code).toMatch(/ownWallets:\s*\{/);
    expect(code).toMatch(/walletCount:\s*external\.length/);
  });

  it("reports how many wallets it actually treats as ours", () => {
    expect(code).toMatch(/configured:\s*ourWallets\.size/);
  });
});
