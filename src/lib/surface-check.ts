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
/**
 * Clients the edge refuses before we ever see them.
 *
 * On 2026-09-14 an outside auditor found `402.com.tr` answering 403 to
 * `Python-urllib/3.12` and `libwww-perl/6.68` while curl got its 402. The block
 * is Cloudflare's — the refusal carries a CF-RAY and no `x-vercel-*` header, so
 * the request never reached the app — and it was site-wide: `/api/catalog` and
 * `/.well-known/x402` were refused too, meaning an agent on Python's standard
 * library could not even discover us, let alone pay.
 *
 * Nothing of ours could have caught it. Our suite, the SMOKE sweep and the
 * keepalive all speak through Node or curl, and a request that is refused at the
 * CDN never becomes a log line, a failed test or a missing index row. It is the
 * third finding in a week that was invisible from inside our own assumptions,
 * and the only one where the fix is not in this repository at all.
 *
 * So this asks the question from outside, in the identities we cannot otherwise
 * speak in. `.well-known/x402` is the target because it is the cheapest public
 * document and the first thing a discovering agent reads: if that is refused,
 * everything behind it is moot.
 */
const AGENT_CLIENTS = ["Python-urllib/3.12", "libwww-perl/6.68", "python-requests/2.32.3", "Go-http-client/2.0"];

/**
 * Hostnames we publish that must answer, not just the one we develop against.
 *
 * `www.402.com.tr` resolved to Cloudflare and returned 523 (origin unreachable)
 * to every client tried — browser, Python and curl alike — because the hostname
 * is proxied at the edge but not configured on the origin. Every link anyone
 * writes with a www is a dead door, and nothing here would ever have said so:
 * the whole suite, this file included, only ever asked the apex.
 */
const PUBLISHED_HOSTS = ["https://402.com.tr", "https://www.402.com.tr"];

export const edgeClientCheck = () =>
  probe("edge/clients", async () => {
    const blocked: string[] = [];
    for (const ua of AGENT_CLIENTS) {
      const r = await fetch(`${SITE}/.well-known/x402`, {
        headers: { "user-agent": ua },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      // 401/403/429 are the edge turning a client away. Anything the app itself
      // answers — including a 402 — means the request got through, which is all
      // this is asking.
      if (r.status === 403 || r.status === 401 || r.status === 429) blocked.push(`${ua} → ${r.status}`);
    }

    // 5xx from the edge is a different failure with the same effect: the client
    // was not refused, the origin was never reached. A 523 on a published
    // hostname is invisible from the apex we always test.
    const deadHosts: string[] = [];
    for (const host of PUBLISHED_HOSTS) {
      try {
        const r = await fetch(`${host}/.well-known/x402`, {
          headers: { "user-agent": AGENT_CLIENTS[0] },
          cache: "no-store",
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });
        if (r.status >= 500) deadHosts.push(`${host} → ${r.status}`);
      } catch (e) {
        deadHosts.push(`${host} → ${e instanceof Error ? e.message.slice(0, 40) : "unreachable"}`);
      }
    }

    /**
     * The hostname we ADVERTISE has to be the one that answers.
     *
     * Everything we publish names the apex — 161 catalogue endpoints, every
     * `resource.url` in a 402 challenge, the discovery records the Bazaar holds,
     * npm, the MCP manifests, the README. On 2026-09-15 adding `www` to the
     * origin project made www primary and turned the apex into a 308 toward it,
     * so every agent following our own published URL took a redirect to reach
     * us. Payments still settled, which is exactly why nothing noticed: the
     * failure is latent, in clients that do not follow redirects or that drop
     * headers across a host change, and in any verifier that compares the
     * advertised resource URL against the URL that served it.
     *
     * So this asserts the property directly. A redirect within the canonical
     * host is fine (http→https, trailing slash); one that lands on a DIFFERENT
     * host means we are advertising an address we no longer serve from.
     */
    let canonical: string | null = null;
    try {
      const r = await fetch(`${SITE}/.well-known/x402`, {
        headers: { "user-agent": AGENT_CLIENTS[0] },
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
      });
      const served = new URL(r.url).host;
      const advertised = new URL(SITE).host;
      if (served !== advertised) {
        canonical = `${advertised} redirects to ${served}, but every URL we publish names ${advertised}`;
      }
    } catch {
      /* the dead-host sweep above already covers unreachable */
    }

    if (blocked.length === 0 && deadHosts.length === 0 && !canonical) {
      return {
        name: "edge/clients",
        ok: true,
        detail: `${AGENT_CLIENTS.length} common agent clients reach the app directly on all ${PUBLISHED_HOSTS.length} published hostnames`,
      };
    }
    return {
      name: "edge/clients",
      ok: false,
      detail:
        (blocked.length
          ? `the CDN refuses ${blocked.join(", ")} before the app is reached — an agent on that client cannot read our price. ` +
            `Not fixable in this repo: it is a Cloudflare bot rule (Security → Bots, or a WAF skip for /api/x402/* and /.well-known/*). `
          : "") +
        (deadHosts.length
          ? `published hostname(s) not serving: ${deadHosts.join(", ")}. A 5xx here is the edge failing to reach the origin — ` +
            `add the hostname to the origin project, or redirect it at the edge so it never gets there. `
          : "") +
        (canonical
          ? `canonical host moved: ${canonical}. Make the advertised host primary on the origin project and point the other at it, ` +
            `rather than re-publishing 161 endpoints and every discovery record under a new name.`
          : ""),
    };
  });

export async function checkSurfaces(payTo: string): Promise<SurfaceResult[]> {
  return Promise.all([npmCheck(), smitheryCheck(), hostedMcpCheck(), discoveryCheck(payTo), edgeClientCheck()]);
}
