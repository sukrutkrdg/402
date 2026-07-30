import { describe, it, expect, vi, afterEach } from "vitest";
import { domainCheck } from "@/lib/domain-check";

/**
 * The verdict logic — the part this endpoint is actually sold on — never ran in a
 * test, because every case needs a registry and no real domain is reliably
 * "registered nine days ago" or "on server hold" when CI happens to run. These
 * drive it from synthetic RDAP documents instead.
 *
 * Kept in its own file on purpose: stubbing the bootstrap fetch populates a
 * module-level cache with a fake registry map, which would otherwise poison the
 * live-network tests in the sibling file. Vitest isolates per file.
 */

type Result = {
  decision: string;
  registered: boolean | null;
  reasons: string[];
  guidance: string;
  ageDays?: number;
  registrar?: string;
  receipt?: { confidence?: { band: string; basis: string } };
};

const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString();

function rdapDoc(over: { registered?: number; expires?: number | null; status?: string[]; nameservers?: string[] }) {
  const events: Array<{ eventAction: string; eventDate: string }> = [];
  if (over.registered !== undefined) events.push({ eventAction: "registration", eventDate: iso(-over.registered) });
  if (over.expires !== null && over.expires !== undefined) {
    events.push({ eventAction: "expiration", eventDate: iso(over.expires) });
  }
  return {
    events,
    status: over.status ?? ["active"],
    nameservers: (over.nameservers ?? ["ns1.example.com"]).map((ldhName) => ({ ldhName })),
    entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Example Registrar"]]] }],
    secureDNS: { delegationSigned: false },
  };
}

/**
 * Answer the IANA bootstrap and then one registry document, nothing else.
 *
 * The base URL has to be a host that really resolves: the SSRF gate every
 * outbound fetch goes through does a DNS lookup before the request, so a
 * made-up `.test` name fails there and every case comes back as a refusal.
 * `fetch` itself is stubbed, so nothing is actually sent to Verisign.
 */
function stubRegistry(doc: unknown) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("data.iana.org")) {
      return new Response(JSON.stringify({ services: [[["com"], ["https://rdap.verisign.com/com/v1/"]]] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/rdap+json" } });
  });
}

const check = async (domain: string) => (await domainCheck({ domain })) as Result;

describe("domainCheck — the fraud signal it is sold on", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("HOLDs a domain registered days ago — the vendor-impersonation pattern", async () => {
    stubRegistry(rdapDoc({ registered: 9, expires: 356 }));
    const r = await check("acme-payments-invoice.com");
    expect(r.decision).toBe("HOLD");
    expect(r.reasons).toContain("recently_registered");
    expect(r.ageDays).toBe(9);
    expect(r.guidance).toMatch(/invoice and vendor-impersonation fraud/i);
  });

  it("GOes on an established domain with room on its registration", async () => {
    stubRegistry(rdapDoc({ registered: 4000, expires: 300 }));
    const r = await check("established.com");
    expect(r.decision).toBe("GO");
    expect(r.reasons).toEqual([]);
    expect(r.receipt?.confidence?.band).toBe("high");
  });

  it("STOPs a domain the registry put on hold, however old it is", async () => {
    stubRegistry(rdapDoc({ registered: 4000, expires: 300, status: ["client hold"] }));
    const r = await check("seized.com");
    expect(r.decision).toBe("STOP");
    expect(r.reasons).toContain("registry_hold_or_deletion");
  });

  it("STOPs an expired registration", async () => {
    stubRegistry(rdapDoc({ registered: 4000, expires: -3 }));
    const r = await check("lapsed.com");
    expect(r.decision).toBe("STOP");
    expect(r.reasons).toContain("registration_expired");
  });

  it("HOLDs when the registration lapses within the month", async () => {
    stubRegistry(rdapDoc({ registered: 4000, expires: 11 }));
    const r = await check("about-to-lapse.com");
    expect(r.decision).toBe("HOLD");
    expect(r.reasons).toContain("expires_within_30_days");
  });

  it("HOLDs a registered domain with nothing delegated", async () => {
    stubRegistry(rdapDoc({ registered: 4000, expires: 300, nameservers: [] }));
    const r = await check("parked.com");
    expect(r.decision).toBe("HOLD");
    expect(r.reasons).toContain("no_nameservers_delegated");
  });

  /**
   * A registry that publishes no expiry, or a status code our sets do not spell,
   * used to fall through to "nothing unusual in its registry record" at high
   * confidence — a clean bill of health issued on fields we never read.
   */
  it("drops confidence instead of blessing a record it could not fully read", async () => {
    stubRegistry(rdapDoc({ registered: 4000, expires: null, status: ["some registry specific code"] }));
    const r = await check("partial.com");
    expect(r.receipt?.confidence?.band).toBe("medium");
    expect(r.reasons).toContain("unrecognised_registry_status");
    expect(r.receipt?.confidence?.basis).toMatch(/expiration-event|unrecognised-status/);
  });

  it("reads the registrar out of the jCard", async () => {
    stubRegistry(rdapDoc({ registered: 4000, expires: 300 }));
    const r = await check("named.com");
    expect(r.registrar).toBe("Example Registrar");
  });
});
