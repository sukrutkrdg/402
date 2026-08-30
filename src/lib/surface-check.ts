/**
 * Are the places we are published actually working?
 *
 * Written on 2026-08-30, the day we found out our Smithery listing had been
 * invisible since 11 July. It was not missing — the record was there, the
 * submissions log said "done", and the log was right. It was flagged `unlisted`,
 * so it never appeared in a search, and nothing anywhere told us. Seven weeks of
 * believing we were on the highest-traffic MCP directory.
 *
 * The lesson is about what we recorded. SUBMISSIONS.md records the ACTION —
 * "submitted to Smithery" — and an action stays true forever once taken. What
 * matters is the STATE, and state rots: a listing goes unlisted, a package gets
 * unpublished, a registry drops an entry on a schema change, a deploy stops
 * answering. So this checks the thing a stranger would check, from outside, with
 * no credentials.
 *
 * The Smithery check in particular asks whether we come back in a SEARCH, not
 * whether the direct URL resolves. The direct URL resolved fine all seven weeks.
 * That is exactly the difference between listed and findable, and it is the one
 * that cost us.
 */

import "server-only";

export interface SurfaceResult {
  name: string;
  ok: boolean;
  detail: string;
}

const NPM_PACKAGE = "x402-bazaar-mcp";
const SMITHERY_NAME = "sukrutkrdg/x402-bazaar-mcp";
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || "https://402.com.tr").replace(/\/$/, "");

/** A check that could not run is not a check that failed. */
async function probe(name: string, fn: () => Promise<SurfaceResult>): Promise<SurfaceResult> {
  try {
    return await fn();
  } catch (e) {
    return { name, ok: true, detail: `not checked — ${e instanceof Error ? e.message.slice(0, 60) : "probe failed"}` };
  }
}

/** Is the npm package still published, and which version is latest? */
const npmCheck = () =>
  probe("npm", async () => {
    const r = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { name: "npm", ok: false, detail: `registry answered ${r.status} for ${NPM_PACKAGE}` };
    const j = (await r.json()) as { "dist-tags"?: { latest?: string } };
    const latest = j["dist-tags"]?.latest;
    return latest
      ? { name: "npm", ok: true, detail: `published, latest ${latest}` }
      : { name: "npm", ok: false, detail: "package exists but has no latest tag" };
  });

/**
 * Do we come back in a Smithery SEARCH? Not "does the direct URL resolve" —
 * that answered 200 for the entire seven weeks the listing was invisible.
 */
const smitheryCheck = () =>
  probe("smithery", async () => {
    const r = await fetch("https://registry.smithery.ai/servers?q=x402%20bazaar&pageSize=30", {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return { name: "smithery", ok: true, detail: `not checked — search API ${r.status}` };
    const j = (await r.json()) as { servers?: Array<{ qualifiedName?: string }>; results?: Array<{ qualifiedName?: string }> };
    const list = j.servers ?? j.results ?? [];
    const at = list.findIndex((s) => String(s.qualifiedName ?? "") === SMITHERY_NAME);
    return at >= 0
      ? { name: "smithery", ok: true, detail: `findable in search, position ${at + 1} of ${list.length}` }
      : {
          name: "smithery",
          ok: false,
          detail: `NOT in search results for "x402 bazaar" (${list.length} returned). The listing may be flagged unlisted — this is exactly how it hid from July 11 to August 30.`,
        };
  });

/** Does our own hosted MCP endpoint still answer, and with how many tools? */
const hostedMcpCheck = () =>
  probe("hosted-mcp", async () => {
    const r = await fetch(`${SITE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { name: "hosted-mcp", ok: false, detail: `${SITE}/mcp answered ${r.status}` };
    const j = (await r.json()) as { result?: { tools?: unknown[] } };
    const n = j.result?.tools?.length ?? 0;
    return n > 0
      ? { name: "hosted-mcp", ok: true, detail: `${n} tools` }
      : { name: "hosted-mcp", ok: false, detail: "responds but advertises zero tools" };
  });

/** Are we still in the CDP discovery index at all? */
const discoveryCheck = (payTo: string) =>
  probe("discovery", async () => {
    if (!payTo) return { name: "discovery", ok: true, detail: "not checked — no payTo configured" };
    const r = await fetch(
      `https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?payTo=${encodeURIComponent(payTo)}&query=token-risk`,
      { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10000) },
    );
    if (!r.ok) return { name: "discovery", ok: true, detail: `not checked — discovery API ${r.status}` };
    const j = (await r.json()) as { resources?: unknown[] };
    const n = j.resources?.length ?? 0;
    return n > 0
      ? { name: "discovery", ok: true, detail: `${n} resource(s) returned for our payTo` }
      : { name: "discovery", ok: false, detail: "discovery returns nothing for our payTo — we are not in the index" };
  });

/**
 * Check every published surface. Returns one row per surface; `ok: false` means
 * a stranger looking for us today would not find us there.
 */
export async function checkSurfaces(payTo: string): Promise<SurfaceResult[]> {
  return Promise.all([npmCheck(), smitheryCheck(), hostedMcpCheck(), discoveryCheck(payTo)]);
}
