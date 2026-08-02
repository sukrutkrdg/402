import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The one thing in this file that can hurt a real person is the checkout URL.
 *
 * A quote comes back from Coinbase with a `pay.coinbase.com` link that has the
 * destination address sealed inside its session token. The quote API insists on
 * a well-formed address even though the pricing does not depend on it, so when
 * the caller does not give us one we send a placeholder — and the URL that comes
 * back pays out to that placeholder. Returning it would hand an agent a link
 * that looks payable and sends a user's money to an address nobody controls.
 *
 * So: the URL is returned only when the caller supplied the address it pays to.
 * That rule is invisible in the response shape (a null field looks like an
 * upstream hiccup, not a deliberate refusal) which is exactly why it is pinned
 * here rather than left to the reviewer's memory.
 */

const OK = {
  payment_total: { value: "100", currency: "USD" },
  payment_subtotal: { value: "97.56", currency: "USD" },
  purchase_amount: { value: "97.56", currency: "USDC" },
  coinbase_fee: { value: "2.44", currency: "USD" },
  network_fee: { value: "0", currency: "USD" },
  quote_id: "q1",
  onramp_url: "https://pay.coinbase.com/buy?sessionToken=SECRET",
};

const OPTIONS = {
  payment_currencies: [{ id: "USD", limits: [{ id: "CARD", min: "2", max: "7500" }, { id: "CARD", min: "2", max: "7500" }] }],
  purchase_currencies: [{ symbol: "USDC", networks: [{ name: "base" }] }],
};

function mockCdp(quote: unknown = OK, options: unknown = OPTIONS) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      new Response(JSON.stringify(String(url).includes("/quote") ? quote : options), { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );
}

beforeEach(() => {
  process.env.CDP_API_KEY_ID = "test-key-id";
  process.env.CDP_API_KEY_SECRET = "test-secret";
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

// The JWT signer needs a real EC key; the network is stubbed anyway, so the
// signing step is the only part of the client we replace.
vi.mock("@coinbase/cdp-sdk/auth", () => ({ generateJwt: async () => "stub-jwt" }));

describe("onramp-quote", () => {
  it("withholds the checkout URL when no destination address was given", async () => {
    mockCdp();
    const { onrampQuote } = await import("../src/lib/onramp");
    const r = (await onrampQuote({ country: "US", amount: "100" })) as Record<string, unknown>;
    const quotes = r.quotes as Array<Record<string, unknown>>;
    expect(quotes.length).toBeGreaterThan(0);
    for (const q of quotes) expect(q.checkoutUrl, `${q.method} leaked a placeholder-bound checkout link`).toBeNull();
    // and says why, so a caller does not read the null as an outage
    expect(String(r.checkoutUrlNote)).toMatch(/address=/);
  });

  it("returns the checkout URL once the caller owns the destination", async () => {
    mockCdp();
    const { onrampQuote } = await import("../src/lib/onramp");
    const r = (await onrampQuote({
      country: "US",
      amount: "100",
      address: "0x973a31858f4d2125f48c880542da11a2796f12d6",
    })) as Record<string, unknown>;
    const quotes = r.quotes as Array<Record<string, unknown>>;
    expect(quotes.some((q) => typeof q.checkoutUrl === "string" && q.checkoutUrl.includes("pay.coinbase.com"))).toBe(true);
  });

  it("collapses the duplicate limit rows Coinbase returns per method", async () => {
    mockCdp();
    const { onrampQuote } = await import("../src/lib/onramp");
    const r = (await onrampQuote({ country: "US", amount: "100" })) as Record<string, unknown>;
    const limits = r.limits as Array<{ method: string }>;
    expect(limits.map((l) => l.method)).toEqual(["CARD"]);
  });

  it("reports a country with no fiat rail as a result, not an error", async () => {
    // Coinbase answers 200 with an empty payment_currencies list for these.
    mockCdp(OK, { payment_currencies: [], purchase_currencies: [{ symbol: "BTC" }] });
    const { onrampQuote } = await import("../src/lib/onramp");
    const r = (await onrampQuote({ country: "TR", amount: "100" })) as Record<string, unknown>;
    expect(r.supported).toBe(false);
    expect(String(r.reason)).toMatch(/no USD payment method/i);
    expect(r.quotes).toEqual([]);
  });

  it("rejects malformed input before spending an upstream call", async () => {
    mockCdp();
    const { onrampQuote } = await import("../src/lib/onramp");
    await expect(onrampQuote({ country: "USA", amount: "100" })).rejects.toThrow(/2-letter/);
    await expect(onrampQuote({ country: "US", amount: "-5" })).rejects.toThrow(/positive/);
    await expect(onrampQuote({ country: "US", amount: "100", address: "nope" })).rejects.toThrow(/0x/);
  });
});
