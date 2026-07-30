import { describe, it, expect } from "vitest";
import { normaliseDomain, domainCheck } from "@/lib/domain-check";

/** The handler returns one of several shapes; a test reads across all of them. */
type Result = {
  decision: string;
  registered: boolean | null;
  reasons: string[];
  guidance: string;
  method?: string;
  ageDays?: number;
  createdAt?: string;
  nameservers?: string[];
  refusal?: { reason: string } | null;
  refundable?: boolean;
  confidence?: { band: string; basis: string };
};
const check = async (domain: string) => (await domainCheck({ domain })) as Result;

describe("normaliseDomain", () => {
  it("strips the things people paste around a domain", () => {
    expect(normaliseDomain("https://Example.com/path?q=1#x")).toBe("example.com");
    expect(normaliseDomain("  EXAMPLE.com.  ")).toBe("example.com");
    expect(normaliseDomain("example.com:8443")).toBe("example.com");
  });

  it("takes the domain out of an email address, because callers paste those", () => {
    expect(normaliseDomain("someone@example.com")).toBe("example.com");
  });

  it("punycodes an internationalised name so the registry query matches", () => {
    expect(normaliseDomain("münchen.de")).toBe("xn--mnchen-3ya.de");
  });
});

describe("domainCheck — input handling", () => {
  it("refuses to call a registry for something that is not a domain", async () => {
    const r = await check("not a domain");
    expect(r.decision).toBe("STOP");
    expect(r.reasons).toContain("invalid_domain_syntax");
    expect(r.method).toBe("syntax only");
  });

  it("rejects a missing domain outright rather than answering emptily", async () => {
    await expect(domainCheck({})).rejects.toThrow(/Missing 'domain'/);
  });
});

/**
 * Live registry calls. These caught two real defects in the sibling endpoint
 * that mocks did not, so the same rule applies here: at least one round against
 * the real thing. RDAP is free and unauthenticated.
 */
describe("domainCheck — live RDAP", () => {
  it("reads an established gTLD domain and says GO", async () => {
    const r = await check("coinbase.com");
    expect(r.decision).toBe("GO");
    expect(r.registered).toBe(true);
    expect(r.ageDays).toBeGreaterThan(365 * 5);
    expect(r.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.nameservers?.length).toBeGreaterThan(0);
    expect(r.confidence?.band).toBe("high");
  }, 30_000);

  it("says STOP — not 'unknown' — when the registry has no such registration", async () => {
    const r = await check("this-domain-does-not-exist-402bazaar-xyz.com");
    expect(r.decision).toBe("STOP");
    expect(r.registered).toBe(false);
    expect(r.reasons).toContain("not_registered");
  }, 30_000);

  /**
   * The honesty case. `.tr` publishes no RDAP service, and the wrong answer here
   * is not "we failed" — it is any verdict at all, because a caller would read
   * a GO on an unverifiable domain as "checked and fine".
   */
  it("refuses, naming the reason, for a TLD that publishes no RDAP", async () => {
    const r = await check("402.com.tr");
    expect(r.decision).toBe("REFUSE");
    expect(r.reasons).toContain("registry_publishes_no_rdap");
    expect(r.refusal).not.toBeNull();
    expect(r.refundable).toBe(true);
    expect(r.guidance).toMatch(/permanent property/i);
  }, 30_000);

  it("marks a refusal refundable so a caller is not billed for a non-answer", async () => {
    const r = await check("402.com.tr");
    expect(r.refundable).toBe(true);
    expect(r.confidence?.band).toBe("low");
  }, 30_000);
});
