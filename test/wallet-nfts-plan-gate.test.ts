import { describe, it, expect, vi, afterEach } from "vitest";
import { walletNfts } from "@/lib/alchemy";

/**
 * Asking for a filter we are not entitled to returned nothing at all.
 *
 * `getNFTsForOwner` was called with `excludeFilters[]=SPAM,AIRDROPS`, which
 * Alchemy gates behind its pay-as-you-go tier. On the free tier that is not a
 * request served without filtering — it is a 400 that refuses the whole call. So
 * `wallet-nfts` was dead in production while `nft-floor`, on the same key and the
 * same host, was healthy: one sends the parameter and the other does not.
 *
 * It stayed invisible because the message never reached anyone. Cloudflare
 * replaces the body of any 5xx with its own gateway page, and the route logged
 * nothing, so the operator saw "502 Bad gateway" and the runtime log held only
 * the request line. The text above was recovered only after the handler started
 * writing its errors down.
 *
 * The repair is to drop the parameter and say so, rather than refuse to answer
 * or quietly imply a filter ran. It also repairs itself: on a paid plan the
 * first attempt succeeds and nothing here changes.
 */

const ADDR = "0x973A31858f4D2125f48C880542DA11a2796f12D6";
const PLAN_400 =
  'The following query parameters: ["excludeFilters":["SPAM"] can only be used with a payg or higher plan. Please upgrade your account here: https://dashboard.alchemy.com/settings/billing.';

const NFT_PAYLOAD = {
  ownedNfts: [
    { contract: { address: "0xAbC0000000000000000000000000000000000001", name: "Real Collection", symbol: "RC" }, balance: "1" },
  ],
  totalCount: 1,
};

const ORIGINAL = process.env.ALCHEMY_API_KEY;
afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL === undefined) delete process.env.ALCHEMY_API_KEY;
  else process.env.ALCHEMY_API_KEY = ORIGINAL;
});

/** Records every URL asked for, so the retry can be inspected. */
function stub(responder: (url: string, attempt: number) => { ok: boolean; status: number; body: unknown }) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(String(url));
    const r = responder(String(url), urls.length);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    } as unknown as Response;
  });
  return urls;
}

describe("wallet-nfts against a plan-gated filter", () => {
  it("retries without the filter and reports that nothing was filtered", async () => {
    process.env.ALCHEMY_API_KEY = "k";
    const urls = stub((url) =>
      url.includes("excludeFilters")
        ? { ok: false, status: 400, body: PLAN_400 }
        : { ok: true, status: 200, body: NFT_PAYLOAD },
    );
    const out = (await walletNfts({ address: ADDR })) as Record<string, unknown>;

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("excludeFilters");
    expect(urls[1], "the retry must drop the gated parameter").not.toContain("excludeFilters");
    expect(out.collectionCount).toBe(1);
    // The buyer is told, in the flag and in the prose they actually read.
    expect(out.spamFiltered).toBe(false);
    expect(String(out.method)).toMatch(/NO spam or airdrop filtering/i);
    expect(String(out.disclaimer)).toMatch(/UNFILTERED/);
  });

  it("asks for the filter first, and says so when it worked", async () => {
    process.env.ALCHEMY_API_KEY = "k";
    const urls = stub(() => ({ ok: true, status: 200, body: NFT_PAYLOAD }));
    const out = (await walletNfts({ address: ADDR })) as Record<string, unknown>;

    expect(urls).toHaveLength(1);
    expect(urls[0], "filtering is still what we prefer").toContain("excludeFilters");
    expect(out.spamFiltered).toBe(true);
    expect(String(out.disclaimer)).toMatch(/heuristic, not a guarantee/);
  });

  it("does not retry a 400 that is about our request rather than our plan", async () => {
    // Repeating a malformed query without the filter just fails twice and bills
    // the caller's patience for it.
    process.env.ALCHEMY_API_KEY = "k";
    const urls = stub(() => ({ ok: false, status: 400, body: "owner is not a valid address" }));
    await expect(walletNfts({ address: ADDR })).rejects.toThrow(/NFT holdings unavailable/);
    expect(urls).toHaveLength(1);
  });

  it("does not fall back to unfiltered on a server-side failure", async () => {
    // fetchRetry retries a 5xx on its own — that is its job and it is not the
    // plan fallback. What must not happen is dropping the filter, which would
    // turn a transient upstream blip into a silently unfiltered answer.
    process.env.ALCHEMY_API_KEY = "k";
    const urls = stub(() => ({ ok: false, status: 500, body: "upstream exploded" }));
    await expect(walletNfts({ address: ADDR })).rejects.toThrow(/Alchemy 500/);
    expect(urls.every((u) => u.includes("excludeFilters"))).toBe(true);
  });

  it("still refuses before spending anything when the key is missing", async () => {
    delete process.env.ALCHEMY_API_KEY;
    const urls = stub(() => ({ ok: true, status: 200, body: NFT_PAYLOAD }));
    await expect(walletNfts({ address: ADDR })).rejects.toThrow(/ALCHEMY_API_KEY/);
    expect(urls).toHaveLength(0);
  });
});
