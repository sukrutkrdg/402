import { describe, it, expect } from "vitest";
import { wearsEquityTicker, issuerControlProfile } from "@/lib/b20-safety";

/**
 * The risk model ranked a plausible security below the token impersonating it.
 *
 * Measured on Base mainnet, 2026-09-04:
 *
 *   GOOGLc "Alphabet Inc."  seizable ✓ freezable ✓ mintGated ✓ rebase ✓  → 85, avoid
 *   COIN   "Bullcoin"       seizable ✗ freezable ✗ mintGated ✗           → 15, hold
 *
 * Both are genuine factory-issued B20s, so the authenticity check calls both
 * genuine and is right to. The safety score then reads issuer control as danger,
 * which is correct for a memecoin and backwards for a security: Base's
 * tokenized-stock spec REQUIRES the issuer to gate holder eligibility and
 * restrict mint/redeem to Authorized Participants. Those powers are the terms of
 * a regulated instrument. Their absence, under a famous ticker, is the tell.
 *
 * So an agent asking "is this the real AAPL" was being handed the ranking upside
 * down — the impersonation scored safer than the thing it imitated.
 *
 * What this does NOT do is claim identity. It reads a control shape. Nothing on
 * chain here proves an issuer is who it says, and the response says so.
 */

describe("wearsEquityTicker", () => {
  it("recognises the tickers Base documents as tokenized stocks", () => {
    for (const t of ["AAPL", "TSLA", "NVDA", "COIN", "GOOGL", "META", "MSTR", "SPCX"]) {
      expect(wearsEquityTicker(t)).toBe(t);
    }
  });

  it("strips a single trailing lowercase suffix", () => {
    // The closest thing to a real issuance found on mainnet calls itself GOOGLc.
    expect(wearsEquityTicker("GOOGLc")).toBe("GOOGL");
    expect(wearsEquityTicker("AAPLx")).toBe("AAPL");
  });

  it("does not match on a prefix, which would catch every memecoin", () => {
    // `COIN` as a prefix would flag half the chain.
    expect(wearsEquityTicker("COINBASE")).toBeNull();
    expect(wearsEquityTicker("COINX")).toBeNull();
    expect(wearsEquityTicker("METAVERSE")).toBeNull();
  });

  it("is not fooled by case or padding, and survives nothing at all", () => {
    expect(wearsEquityTicker("aapl")).toBe("AAPL");
    expect(wearsEquityTicker("  TSLA  ")).toBe("TSLA");
    expect(wearsEquityTicker("")).toBeNull();
    expect(wearsEquityTicker(null)).toBeNull();
    expect(wearsEquityTicker(undefined)).toBeNull();
  });

  it("leaves ordinary symbols alone", () => {
    for (const s of ["USDC", "SWARM", "BRICKS", "NADT", "DOVE"]) expect(wearsEquityTicker(s)).toBeNull();
  });
});

describe("issuerControlProfile", () => {
  it("needs BOTH holder eligibility and mint gating", () => {
    // Either alone is a normal thing for a token to have; together they are the
    // shape the tokenized-stock spec asks of an issuer.
    expect(issuerControlProfile({ transferGated: true, mintGated: true })).toBe(true);
    expect(issuerControlProfile({ transferGated: true, mintGated: false })).toBe(false);
    expect(issuerControlProfile({ transferGated: false, mintGated: true })).toBe(false);
    expect(issuerControlProfile({ transferGated: false, mintGated: false })).toBe(false);
  });
});

/**
 * Ground truth, read off Base mainnet on 2026-09-04.
 *
 * The first two are the tokenized stocks Coinbase issues in the Base app. The
 * other two are what everything else looks like. The classifier was written from
 * the spec before these addresses were known, and this is the check that it
 * describes the real instruments rather than a guess about them.
 *
 *   0xb2000000000000000000002d0ba3164cc74f58b7  GOOGLc  Alphabet Inc.
 *   0xb2000000000000000000008bc8786b856e61707c  METAc   Meta Platforms Inc.
 *   0xb200000000000000000000c5650468d8f3c1a201  COIN    "Bullcoin"
 *   0xb200000000000000000000899f83822ff84b8fb3  SWARM   Base Swarm
 *
 * Both issuances set TRANSFER_SENDER, TRANSFER_RECEIVER and MINT_RECEIVER
 * policies and carry 8 decimals; neither of the others sets a single policy and
 * both carry 18. Decimals are left out of the rule on purpose — two samples is
 * not enough to gate a verdict on a convention, and the policy shape is what the
 * spec actually requires.
 */
const MAINNET = [
  { label: "GOOGLc (Coinbase issuance)", symbol: "GOOGLc", transferGated: true, mintGated: true, ticker: "GOOGL", controlled: true },
  { label: "METAc (Coinbase issuance)", symbol: "METAc", transferGated: true, mintGated: true, ticker: "META", controlled: true },
  { label: "Bullcoin (ticker squatter)", symbol: "COIN", transferGated: false, mintGated: false, ticker: "COIN", controlled: false },
  { label: "Base Swarm (ordinary B20)", symbol: "SWARM", transferGated: false, mintGated: false, ticker: null, controlled: false },
] as const;

describe("against the real tokens on Base mainnet", () => {
  for (const t of MAINNET) {
    it(`classifies ${t.label}`, () => {
      expect(wearsEquityTicker(t.symbol)).toBe(t.ticker);
      expect(issuerControlProfile(t)).toBe(t.controlled);
    });
  }

  it("penalises only the impersonation, not the issuances", () => {
    const penalty = (t: (typeof MAINNET)[number]) =>
      wearsEquityTicker(t.symbol) && !issuerControlProfile(t) ? 30 : 0;
    expect(penalty(MAINNET[0]), "GOOGLc must not be penalised for being controlled").toBe(0);
    expect(penalty(MAINNET[1]), "METAc must not be penalised either").toBe(0);
    expect(penalty(MAINNET[2]), "the squatter is the one that earns it").toBe(30);
    expect(penalty(MAINNET[3]), "an ordinary token wearing no ticker is untouched").toBe(0);
  });

  it("reads the issuer's own naming convention", () => {
    // Coinbase suffixes the ticker with a lowercase `c`. The rule that strips a
    // single trailing lowercase letter was written before these were known.
    expect(wearsEquityTicker("GOOGLc")).toBe("GOOGL");
    expect(wearsEquityTicker("METAc")).toBe("META");
  });
});

describe("the inversion this was built to fix", () => {
  /** The two mainnet tokens, as the signal reader saw them. */
  const alphabet = { symbol: "GOOGLc", transferGated: true, mintGated: true };
  const bullcoin = { symbol: "COIN", transferGated: false, mintGated: false };

  it("classifies the controlled one as an instrument, not a scam", () => {
    expect(wearsEquityTicker(alphabet.symbol)).toBe("GOOGL");
    expect(issuerControlProfile(alphabet)).toBe(true);
  });

  it("flags the uncontrolled ticker as something that cannot be a security", () => {
    expect(wearsEquityTicker(bullcoin.symbol)).toBe("COIN");
    expect(issuerControlProfile(bullcoin)).toBe(false);
  });

  it("penalises the impersonation, which previously scored safest of all", () => {
    // Reproduces the scoring rule: a ticker with no issuer controls takes the
    // +30 that used to go uncounted, so it can no longer read as the calm one.
    const score = (t: { symbol: string; transferGated: boolean; mintGated: boolean }) =>
      wearsEquityTicker(t.symbol) && !issuerControlProfile(t) ? 30 : 0;
    expect(score(bullcoin)).toBe(30);
    expect(score(alphabet)).toBe(0);
  });
});

describe("the route wires it into the answer", () => {
  it("reports the classification and refuses to claim identity", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/lib/b20-safety.ts", import.meta.url), "utf8"),
    );
    expect(src).toMatch(/assetProfile/);
    expect(src).toMatch(/equityTicker/);
    expect(src).toMatch(/issuerControlled/);
    // The honesty guard: we read a control shape, never an identity.
    expect(src).toMatch(/verified: false/);
    expect(src, "must say plainly that this is not an identity check").toMatch(/control shape, not the identity/);
  });

  it("does not tell a holder to avoid an asset class", async () => {
    // "Avoid holding size" is right for a memecoin with seize powers and wrong
    // for a security whose terms include them, so the recommendation branches on
    // the profile before it reaches the verdict.
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/lib/b20-safety.ts", import.meta.url), "utf8");
    expect(src).toMatch(/that is the deal rather than a defect/);
    expect(
      src.indexOf("issuerControlled\n        ? `Issuer-controlled"),
      "the profile branch must come before the verdict branch",
    ).toBeLessThan(src.indexOf('verdict === "avoid" ? "Avoid holding size'));
  });
});
