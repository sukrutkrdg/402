import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The valuable behaviour here is the distinction between "this domain takes no
 * mail" and "DNS didn't answer" — the first is a result the caller can act on,
 * the second must not be sold as one. Everything else is classification.
 */
const { mxMock, a4Mock, a6Mock } = vi.hoisted(() => ({
  mxMock: vi.fn(),
  a4Mock: vi.fn(),
  a6Mock: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ resolveMx: mxMock, resolve4: a4Mock, resolve6: a6Mock }));

import { emailVerify } from "@/lib/email-verify";

type Result = Record<string, any>;

/** Domain with normal mail setup. */
function healthy() {
  mxMock.mockResolvedValue([
    { exchange: "alt2.aspmx.l.example.com", priority: 20 },
    { exchange: "aspmx.l.example.com", priority: 10 },
  ]);
  a4Mock.mockResolvedValue(["93.184.216.34"]);
  a6Mock.mockRejectedValue(new Error("no AAAA"));
}

describe("emailVerify — input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    healthy();
  });
  afterEach(() => vi.clearAllMocks());

  it("rejects an empty address without a lookup", async () => {
    await expect(emailVerify({ email: " " })).rejects.toThrow(/missing 'email'/i);
    expect(mxMock).not.toHaveBeenCalled();
  });

  it("rejects an over-long address", async () => {
    await expect(emailVerify({ email: `${"a".repeat(250)}@x.com` })).rejects.toThrow(/too long/i);
  });

  it("answers bad syntax from syntax alone, with no DNS call", async () => {
    for (const bad of ["not-an-email", "a@b", "@example.com", "user@", "user @example.com", "user@exa mple.com"]) {
      const r = (await emailVerify({ email: bad })) as Result;
      expect(r.decision, bad).toBe("STOP");
      expect(r.deliverable).toBe(false);
      expect(r.reasons).toContain("invalid_syntax");
    }
    expect(mxMock).not.toHaveBeenCalled();
  });

  it("accepts the awkward-but-legal local parts real providers allow", async () => {
    const r = (await emailVerify({ email: "first.last+tag@sub.example.co.uk" })) as Result;
    expect(r.syntaxValid).toBe(true);
    expect(r.domain).toBe("sub.example.co.uk");
  });
});

describe("emailVerify — deliverability", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("passes a healthy business domain and sorts MX by priority", async () => {
    healthy();
    const r = (await emailVerify({ email: "jane@acme-corp.com" })) as Result;
    expect(r.decision).toBe("GO");
    expect(r.deliverable).toBe(true);
    expect(r.mx[0].priority).toBe(10); // lowest priority first
    expect(r.reasons).toHaveLength(0);
  });

  it("marks a domain with no mail records as undeliverable", async () => {
    mxMock.mockResolvedValue([]);
    a4Mock.mockResolvedValue([]);
    a6Mock.mockResolvedValue([]);
    const r = (await emailVerify({ email: "someone@no-mail-here.example" })) as Result;
    expect(r.decision).toBe("STOP");
    expect(r.deliverable).toBe(false);
    expect(r.reasons).toContain("domain_accepts_no_mail");
  });

  it("treats an A record with no MX as deliverable, per RFC 5321 fallback", async () => {
    mxMock.mockResolvedValue([]);
    a4Mock.mockResolvedValue(["203.0.113.5"]);
    a6Mock.mockResolvedValue([]);
    const r = (await emailVerify({ email: "legacy@old-host.example" })) as Result;
    expect(r.deliverable).toBe(true);
    expect(r.reasons).toContain("no_mx_falls_back_to_a_record");
  });

  it("says STOP, not REFUSE, for a domain that does not exist", async () => {
    // NXDOMAIN is an ANSWER. Treating it as an outage told callers to retry an
    // address that can never receive mail — caught by a live check, not a mock.
    const nx = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    mxMock.mockRejectedValue(nx);
    a4Mock.mockRejectedValue(nx);
    a6Mock.mockRejectedValue(nx);
    const r = (await emailVerify({ email: "someone@does-not-exist.example" })) as Result;
    expect(r.decision).toBe("STOP");
    expect(r.deliverable).toBe(false);
    expect(r.reasons).toContain("domain_does_not_resolve");
    expect(r.reasons).toContain("domain_accepts_no_mail"); // the actionable fact, still reported
    expect(r.receipt.confidence.band).toBe("high"); // we know the answer, so confidence is not degraded
  });

  it("says STOP for a domain that exists with no mail records (ENODATA)", async () => {
    const nodata = Object.assign(new Error("queryMx ENODATA"), { code: "ENODATA" });
    mxMock.mockRejectedValue(nodata);
    a4Mock.mockRejectedValue(nodata);
    a6Mock.mockRejectedValue(nodata);
    const r = (await emailVerify({ email: "someone@parked.example" })) as Result;
    expect(r.decision).toBe("STOP");
    expect(r.reasons).toContain("domain_accepts_no_mail");
  });

  it("REFUSES when DNS fails for a reason that is not an answer (SERVFAIL)", async () => {
    const servfail = Object.assign(new Error("queryMx ESERVFAIL"), { code: "ESERVFAIL" });
    mxMock.mockRejectedValue(servfail);
    a4Mock.mockRejectedValue(servfail);
    a6Mock.mockRejectedValue(servfail);
    const r = (await emailVerify({ email: "jane@acme-corp.com" })) as Result;
    expect(r.decision).toBe("REFUSE");
    expect(r.deliverable).toBeNull();
  });

  it("REFUSES rather than answering when DNS does not respond", async () => {
    // The distinction that matters: unknown is not the same as undeliverable.
    mxMock.mockImplementation(() => new Promise(() => {}));
    a4Mock.mockImplementation(() => new Promise(() => {}));
    a6Mock.mockImplementation(() => new Promise(() => {}));
    const r = (await emailVerify({ email: "jane@acme-corp.com" })) as Result;
    expect(r.decision).toBe("REFUSE");
    expect(r.deliverable).toBeNull();
    expect(r.reasons).toContain("dns_unavailable");
    expect(r.receipt.confidence.band).toBe("low");
    expect(r.receipt.refusal).not.toBeNull();
  }, 20000);
});

describe("emailVerify — classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    healthy();
  });
  afterEach(() => vi.clearAllMocks());

  it("flags a disposable inbox but keeps it deliverable", async () => {
    const r = (await emailVerify({ email: "throwaway@mailinator.com" })) as Result;
    expect(r.disposable).toBe(true);
    expect(r.deliverable).toBe(true); // it does receive mail — that's the point of it
    expect(r.decision).toBe("HOLD");
  });

  it("flags a shared role mailbox, including punctuated variants", async () => {
    expect(((await emailVerify({ email: "support@acme.com" })) as Result).roleAccount).toBe(true);
    expect(((await emailVerify({ email: "no-reply@acme.com" })) as Result).roleAccount).toBe(true);
    expect(((await emailVerify({ email: "jane.doe@acme.com" })) as Result).roleAccount).toBe(false);
  });

  it("identifies a consumer mailbox without holding it", async () => {
    const r = (await emailVerify({ email: "jane@gmail.com" })) as Result;
    expect(r.freeProvider).toBe(true);
    expect(r.decision).toBe("GO"); // a personal gmail is a fine address
    expect(r.reasons).toContain("consumer_mailbox");
  });

  it("suggests the intended domain for a one-character typo", async () => {
    expect(((await emailVerify({ email: "jane@gmial.com" })) as Result).suggestedDomain).toBe("gmail.com");
    expect(((await emailVerify({ email: "jane@hotmial.com" })) as Result).suggestedDomain).toBe("hotmail.com");
    expect(((await emailVerify({ email: "jane@gmai.com" })) as Result).suggestedDomain).toBe("gmail.com");
  });

  it("does not invent a typo for an unrelated domain", async () => {
    const r = (await emailVerify({ email: "jane@acme-industrial.com" })) as Result;
    expect(r.suggestedDomain).toBeNull();
    expect(r.reasons).not.toContain("possible_domain_typo");
  });

  it("does not flag the real domain as a typo of itself", async () => {
    expect(((await emailVerify({ email: "jane@gmail.com" })) as Result).suggestedDomain).toBeNull();
  });

  it("carries a decision receipt and states that SMTP was not probed", async () => {
    const r = (await emailVerify({ email: "jane@acme-corp.com" })) as Result;
    expect(r.receipt.policyVersion).toBe("email-verify@1.0.0");
    expect(r.receipt.inputHash).toMatch(/^sha256:/);
    expect(r.receipt.confidence.band).toBe("high");
    expect(r.method).toMatch(/no smtp probe/i);
  });
});
