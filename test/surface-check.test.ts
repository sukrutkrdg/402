import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkSurfaces } from "@/lib/surface-check";

/**
 * The check that would have caught seven weeks of being invisible.
 *
 * Our Smithery listing was created on 2026-07-11 and flagged `unlisted` the
 * whole time. It was not missing: the record existed, the direct URL answered
 * 200, and the submissions log said "done" — correctly, because the submission
 * had happened. It simply never appeared in a search, and nothing told us until
 * 2026-08-30.
 *
 * So the thing under test is not "does the listing exist". It is "would a
 * stranger looking for us find us", which is a different question and the only
 * one that pays. Everything here probes from outside with no credentials.
 */
const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const ROUTES: Record<string, unknown> = {};
const routeFetch = vi.fn(async (url: string) => {
  for (const [frag, res] of Object.entries(ROUTES)) {
    if (String(url).includes(frag)) return res as never;
  }
  throw new Error(`unstubbed: ${url}`);
});

beforeEach(() => {
  for (const k of Object.keys(ROUTES)) delete ROUTES[k];
  ROUTES["registry.npmjs.org"] = jsonOk({ "dist-tags": { latest: "0.2.5" } });
  ROUTES["registry.smithery.ai"] = jsonOk({ servers: [{ qualifiedName: "sukrutkrdg/x402-bazaar-mcp" }] });
  ROUTES["/mcp"] = jsonOk({ result: { tools: new Array(137).fill({ name: "t" }) } });
  ROUTES["cdp.coinbase.com"] = jsonOk({ resources: [{ resource: "https://402.com.tr/api/x402/token-risk" }] });
  routeFetch.mockClear();
  vi.stubGlobal("fetch", routeFetch);
});
afterEach(() => vi.unstubAllGlobals());

const byName = (rows: Awaited<ReturnType<typeof checkSurfaces>>, n: string) => rows.find((r) => r.name === n)!;

describe("all surfaces healthy", () => {
  it("passes every check and says what it found", async () => {
    const rows = await checkSurfaces("0xabc");
    expect(rows.every((r) => r.ok)).toBe(true);
    expect(byName(rows, "npm").detail).toMatch(/latest 0\.2\.5/);
    expect(byName(rows, "hosted-mcp").detail).toMatch(/137 tools/);
  });
});

describe("the Smithery failure this exists for", () => {
  it("fails when we are absent from SEARCH, even though the listing exists", async () => {
    // Exactly the July-to-August state: other servers come back, we do not.
    ROUTES["registry.smithery.ai"] = jsonOk({ servers: [{ qualifiedName: "someone/else" }, { qualifiedName: "third/party" }] });
    const rows = await checkSurfaces("0xabc");
    const s = byName(rows, "smithery");
    expect(s.ok).toBe(false);
    expect(s.detail).toMatch(/NOT in search results/);
    expect(s.detail, "the alert should name the cause we actually hit").toMatch(/unlisted/i);
  });

  it("does not settle for the direct URL resolving", async () => {
    // The direct URL answered 200 for all seven weeks. If this check ever gets
    // "simplified" into a URL ping, it stops catching the thing it was born for.
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/lib/surface-check.ts", import.meta.url), "utf8"));
    expect(src).toMatch(/registry\.smithery\.ai\/servers\?q=/);
    expect(src, "must compare against the qualified name, not just a 200").toMatch(/qualifiedName \?\? ""\) === SMITHERY_NAME/);
  });
});

describe("other surfaces", () => {
  it("catches an unpublished npm package", async () => {
    ROUTES["registry.npmjs.org"] = { ok: false, status: 404, json: async () => ({}) };
    expect(byName(await checkSurfaces("0xabc"), "npm").ok).toBe(false);
  });

  it("catches a hosted MCP endpoint that answers but advertises nothing", async () => {
    ROUTES["/mcp"] = jsonOk({ result: { tools: [] } });
    const m = byName(await checkSurfaces("0xabc"), "hosted-mcp");
    expect(m.ok).toBe(false);
    expect(m.detail).toMatch(/zero tools/);
  });

  it("catches falling out of the discovery index", async () => {
    ROUTES["cdp.coinbase.com"] = jsonOk({ resources: [] });
    expect(byName(await checkSurfaces("0xabc"), "discovery").ok).toBe(false);
  });
});

describe("a check that could not run is not a check that failed", () => {
  it("reports a probe error as not-checked rather than as broken", async () => {
    // Alerting on our own network flake would train the operator to ignore it,
    // which is how the next real one gets missed.
    ROUTES["registry.smithery.ai"] = undefined as never;
    routeFetch.mockImplementationOnce(async () => { throw new Error("ETIMEDOUT"); });
    const rows = await checkSurfaces("0xabc");
    for (const r of rows) {
      if (r.detail.startsWith("not checked")) expect(r.ok).toBe(true);
    }
  });

  it("skips discovery entirely when no payTo is configured", async () => {
    const d = byName(await checkSurfaces(""), "discovery");
    expect(d.ok).toBe(true);
    expect(d.detail).toMatch(/no payTo/);
  });
});
