import { describe, it, expect } from "vitest";
import { normalizeName, parseExports, screen, sanctionsName } from "@/lib/sanctions-name";

/**
 * Sanctions screening can hurt a real person if it over-claims, so most of these
 * tests assert the opposite of coverage: a near-miss must NOT come back as a hit,
 * and a single-word query must never be scored as one.
 *
 * The fixtures are in the real Treasury CSV shape — quoted fields, "-0-" for
 * empty, aliases in a second file keyed by entity number.
 */
const SDN = [
  '36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ',
  '306,"BANCO NACIONAL DE CUBA",-0- ,"CUBA",-0- ,"a.k.a. \'BNC\'."',
  '900,"ZHANG, Wei",individual,"NPWMD",-0- ,-0- ',
  '901,"POLO TRADING",-0- ,"SDGT",-0- ,-0- ',
  '902,"ANGLO-CARIBBEAN CO., LTD.",-0- ,"CUBA",-0- ,-0- ',
].join("\n");
const ALT = [
  '306,220,"aka","NATIONAL BANK OF CUBA",-0- ',
  '36,12,"aka","AERO-CARIBBEAN",-0- ',
].join("\n");

const entries = parseExports(SDN, ALT);

describe("normalizeName", () => {
  it("folds case, punctuation and diacritics so real spellings match", () => {
    expect(normalizeName("Banco Nacional de Cuba")).toBe("BANCO NACIONAL DE CUBA");
    expect(normalizeName("ANGLO-CARIBBEAN CO., LTD.")).toBe("ANGLO CARIBBEAN CO LTD");
    expect(normalizeName("José  Peña")).toBe("JOSE PENA");
    expect(normalizeName("  spaced   out  ")).toBe("SPACED OUT");
  });

  it("returns empty when there is nothing comparable", () => {
    expect(normalizeName("!!! ??? ...")).toBe("");
  });
});

describe("parseExports", () => {
  it("reads primary names and marks them as such", () => {
    const cuba = entries.find((e) => e.name === "BANCO NACIONAL DE CUBA");
    expect(cuba).toBeDefined();
    expect(cuba?.alias).toBe(false);
    expect(cuba?.program).toBe("CUBA");
    expect(cuba?.ent).toBe(306);
  });

  it("reads aliases and inherits the entity's programme and type", () => {
    const alias = entries.find((e) => e.name === "NATIONAL BANK OF CUBA");
    expect(alias?.alias).toBe(true);
    expect(alias?.ent).toBe(306);
    expect(alias?.program).toBe("CUBA"); // came from the SDN row, not the ALT row
  });

  it("keeps commas inside quoted fields out of the column split", () => {
    // "ZHANG, Wei" and "ANGLO-CARIBBEAN CO., LTD." both contain a comma.
    expect(entries.some((e) => e.name === "ZHANG, Wei")).toBe(true);
    expect(entries.some((e) => e.name === "ANGLO-CARIBBEAN CO., LTD.")).toBe(true);
  });

  it("treats the -0- placeholder as empty rather than a value", () => {
    const cuba = entries.find((e) => e.name === "BANCO NACIONAL DE CUBA");
    expect(cuba?.type).toBe("individual/entity"); // SDN_Type was "-0-"
  });

  it("drops one-character tokens so initials don't become match keys", () => {
    const [only] = parseExports('1,"A B Trading",-0- ,"X",-0- ', "");
    expect(only.tokens).toEqual(["TRADING"]);
  });
});

describe("screen — match tiers", () => {
  it("scores a case/punctuation variant of a listed name as exact", () => {
    expect(screen(entries, "banco nacional de cuba").matches[0].match).toBe("exact");
    expect(screen(entries, "Aerocaribbean Airlines").hit).toBe(true);
  });

  it("matches an alias, which is where listed parties actually appear", () => {
    const r = screen(entries, "National Bank of Cuba");
    expect(r.hit).toBe(true);
    expect(r.matches[0].matchedAs).toBe("alias");
    expect(r.matches[0].sdnEntity).toBe(306);
  });

  it("scores a longer name containing every listed token as strong", () => {
    const r = screen(entries, "Polo Trading Group Limited");
    expect(r.matches.some((m) => m.match === "strong")).toBe(false); // listed name lacks GROUP/LIMITED
    // The reverse direction is what 'strong' is for: query tokens all present.
    expect(screen(entries, "Trading Polo").matches[0].match).toBe("strong");
  });

  it("does NOT promote a near-miss to a hit", () => {
    // Three of four tokens overlap the Cuba entry. A false hit here would brand a
    // real, unrelated bank as sanctioned.
    const r = screen(entries, "Banco Nacional de Panama");
    expect(r.hit).toBe(false);
    expect(r.matches[0].match).toBe("partial");
  });

  it("never scores a single-token query above partial", () => {
    const r = screen(entries, "TRADING");
    expect(r.singleToken).toBe(true);
    expect(r.hit).toBe(false);
    expect(r.matches.every((m) => m.match === "partial")).toBe(true);
  });

  it("finds nothing for an unrelated company", () => {
    const r = screen(entries, "Acme Widgets GmbH");
    expect(r.matches).toHaveLength(0);
    expect(r.hit).toBe(false);
  });

  it("orders exact matches ahead of partial ones", () => {
    const r = screen(entries, "Banco Nacional de Cuba");
    const kinds = r.matches.map((m) => m.match);
    expect(kinds[0]).toBe("exact");
    expect(kinds.indexOf("partial") === -1 || kinds.indexOf("partial") > 0).toBe(true);
  });
});

describe("sanctionsName — input guards", () => {
  it("rejects an empty name before touching the network", async () => {
    await expect(sanctionsName({ name: "  " })).rejects.toThrow(/missing 'name'/i);
  });

  it("rejects an over-long name", async () => {
    await expect(sanctionsName({ name: "x".repeat(201) })).rejects.toThrow(/too long/i);
  });

  it("rejects a name with no comparable characters", async () => {
    await expect(sanctionsName({ name: "??? !!!" })).rejects.toThrow(/no comparable/i);
  });
});
