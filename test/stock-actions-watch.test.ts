import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  TOKENIZED_STOCKS,
  tokenizedStockFor,
  describeMultiplierChange,
  STOCK_POLICY_ADMIN,
  WAD,
} from "@/lib/tokenized-stocks";
import { ALERT_KINDS } from "@/lib/alert-owner";

/**
 * The watcher has one job and exactly one chance to do it.
 *
 * Across all thirteen of Base's tokenized equities the number of multiplier
 * changes to date is zero. Every code path here therefore runs unexercised by
 * production until the day it matters, which is the day it must not be wrong.
 * So the properties that decide whether the first event is caught or lost are
 * pinned here rather than left to the first live firing.
 */

describe("the roster", () => {
  it("holds all thirteen stocks found on chain", () => {
    expect(TOKENIZED_STOCKS).toHaveLength(13);
  });

  it("names each one as its ticker plus a c, which is how the issuer symbols them", () => {
    for (const s of TOKENIZED_STOCKS) expect(s.sym).toBe(`${s.ticker}c`);
  });

  it("stores addresses lowercased, because the KV keys and SQL filters compare raw", () => {
    for (const s of TOKENIZED_STOCKS) {
      expect(s.token).toBe(s.token.toLowerCase());
      expect(s.token).toMatch(/^0xb200[0-9a-f]{36}$/);
    }
  });

  it("has no duplicate address or symbol", () => {
    expect(new Set(TOKENIZED_STOCKS.map((s) => s.token)).size).toBe(13);
    expect(new Set(TOKENIZED_STOCKS.map((s) => s.sym)).size).toBe(13);
  });

  it("matches a checksummed address, since callers and explorers hand those over", () => {
    const meta = "0xB2000000000000000000008bC8786B856e61707c";
    expect(tokenizedStockFor(meta)?.sym).toBe("METAc");
    expect(tokenizedStockFor(meta.toLowerCase())?.sym).toBe("METAc");
  });

  it("does not claim a token it has never seen", () => {
    expect(tokenizedStockFor("0xb200000000000000000000000000000000000000")).toBeNull();
    expect(tokenizedStockFor("")).toBeNull();
  });

  it("keeps the operator anchor lowercased so the b20-safety lookup hits", () => {
    expect(STOCK_POLICY_ADMIN).toBe(STOCK_POLICY_ADMIN.toLowerCase());
  });
});

describe("how a multiplier move is described", () => {
  it("says nothing happened when nothing happened", () => {
    expect(describeMultiplierChange(WAD, WAD)).toBe("unchanged");
  });

  it("reads a 4x as a split — more units, explicitly not more value", () => {
    const d = describeMultiplierChange(WAD, WAD * 4n);
    expect(d).toMatch(/up 4×/);
    expect(d).toMatch(/split-shaped/);
    expect(d).toMatch(/not more value/);
  });

  it("reads a halving as a reverse split, not as a loss", () => {
    const d = describeMultiplierChange(WAD, WAD / 2n);
    expect(d).toMatch(/down 0\.5×/);
    expect(d).toMatch(/reverse-split-shaped/);
    expect(d).toMatch(/not less value/);
  });

  /**
   * The failure mode of a terse alert at 05:00 is an operator reading a 4×
   * redenomination as a windfall and acting on it. The wording is the guard.
   */
  it("never uses the vocabulary of profit or loss", () => {
    const samples = [
      describeMultiplierChange(WAD, WAD * 4n),
      describeMultiplierChange(WAD, WAD / 2n),
    ];
    for (const d of samples) expect(d).not.toMatch(/gain|profit|loss|worth|%|percent/i);
  });

  it("survives a zero previous value instead of dividing by it", () => {
    expect(() => describeMultiplierChange(0n, WAD)).not.toThrow();
  });
});

describe("alert kinds are declared once", () => {
  /**
   * `index-gap` was raised into KV and rendered nowhere for its first days
   * because /api/revenue kept a second, shorter copy of this list. The list and
   * the type are now the same thing.
   */
  it("includes the watcher's kind", () => {
    expect(ALERT_KINDS).toContain("stock-actions");
  });

  it("is what the revenue panel iterates, not a local copy", () => {
    const src = readFileSync("src/app/api/revenue/route.ts", "utf8");
    expect(src).toMatch(/const kinds = ALERT_KINDS/);
    expect(src).not.toMatch(/const kinds = \[/);
  });
});

describe("the cron cannot lose the first event", () => {
  const src = readFileSync("src/app/api/cron/stock-actions/route.ts", "utf8");

  /**
   * The single most damaging bug available here: writing a failed read back as
   * the baseline. It would overwrite the last good value, so the real change
   * that followed would compare equal and never be reported — the watcher
   * failing silently in precisely the case it exists for.
   */
  it("skips a token it could not read rather than rebaselining it", () => {
    expect(src).toMatch(/if \(r\.multiplier === null\) continue;/);
  });

  it("refuses to draw a conclusion when every read failed", () => {
    expect(src).toMatch(/unreadable\.length === reads\.length/);
    expect(src).toMatch(/skipped: "degraded"/);
  });

  it("seeds a first sighting silently instead of alerting thirteen times on deploy", () => {
    const seed = src.slice(src.indexOf("if (prev === null)"), src.indexOf("if (prev === r.multiplier)"));
    expect(seed).toMatch(/kvSet/);
    expect(seed).not.toMatch(/alertOwner/);
  });

  it("compares state to decide, and only then looks for the transaction", () => {
    // Evidence decorates an alert that state already justified. If the SQL
    // lookup gated the alert, an indexer lag would suppress the one report
    // this cron is for.
    expect(src.indexOf("if (prev === r.multiplier) continue;")).toBeLessThan(src.indexOf("findEvidence(r.token)"));
    expect(src).toMatch(/catch \{\s*return \{\};\s*\}/);
  });

  it("does not pretend to know whether a change was scheduled or an emergency", () => {
    // No sample of either exists to write that parsing against. Guessing the
    // shape now and being wrong on the one day it fires wastes the whole point.
    expect(src).not.toMatch(/updateUIMultiplier|ERC-?8056 (parse|classif)/i);
  });
});
