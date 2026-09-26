import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * NEAR Intents credit rail. What must hold:
 *   - the quote we send pays OUR payTo, in Base USDC, for exactly the pack price;
 *   - a paid order mints exactly once, however often it is polled;
 *   - the same token comes back on a repeat poll (a dropped response loses nothing);
 *   - a wrong secret, or a swap that does not match the stored quote, mints nothing;
 *   - with the flag off, the routes do not exist.
 */

const PAY_TO = "0x1111111111111111111111111111111111111111";
const ASSET = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

const { store, kvMock, mintMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const kvMock = {
    kvConfigured: vi.fn(() => true),
    kvGet: vi.fn(async (k: string) => store.get(k) ?? null),
    kvSetChecked: vi.fn(async (k: string, v: string): Promise<{ ok: boolean; detail?: string }> => {
      store.set(k, v);
      return { ok: true };
    }),
    kvSetNx: vi.fn(async (k: string) => {
      if (store.has(k)) return false;
      store.set(k, "1");
      return true;
    }),
    kvDel: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    kvIncrBy: vi.fn(async (k: string, by: number) => {
      const n = Number(store.get(k) ?? 0) + by;
      store.set(k, String(n));
      return n;
    }),
    kvGetNumber: vi.fn(async (k: string) => Number(store.get(k) ?? 0)),
    kvIncr: vi.fn(async () => 1),
  };
  let n = 0;
  const mintMock = vi.fn(async (credits: number, paidUsd: number) => ({
    creditToken: `ck_${String(++n).padStart(36, "0")}`,
    balanceUsd: credits / 100,
    paidUsd,
    creditedUsd: credits / 100,
  }));
  return { store, kvMock, mintMock };
});

vi.mock("@/lib/kv", () => kvMock);
const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn(async (_text: string) => ({ ok: true })) }));
vi.mock("@/lib/alert-owner", () => ({ notifyOwner: notifyMock }));
vi.mock("@/lib/credits", () => ({
  CREDIT_TIERS: {
    "0.25": { usd: 0.25, credits: 25 },
    "1": { usd: 1, credits: 100 },
    "5": { usd: 5, credits: 550 },
    "20": { usd: 20, credits: 2400 },
  },
  mintCredits: mintMock,
}));

import {
  createNearOrder,
  checkNearOrder,
  nearRailLedger,
  _resetAssetCache,
  NearOrderError,
  ASSET_RE,
} from "@/lib/near-intents";

type Json = Record<string, unknown>;
let lastQuoteBody: Json | null = null;
let statusReply: Json = {};

function mockOneClick() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v0/tokens")) {
        return new Response(
          JSON.stringify([
            { assetId: "nep141:wrap.near", blockchain: "near", symbol: "wNEAR" },
            { assetId: ASSET, blockchain: "base", symbol: "USDC", contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
          ]),
        );
      }
      if (u.endsWith("/v0/quote")) {
        lastQuoteBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            signature: "sig",
            quote: {
              depositAddress: "deposit.near",
              amountIn: "2000000000000000000000000",
              amountInFormatted: "2.0",
              amountInUsd: "5.05",
              minAmountIn: "1980000000000000000000000",
              deadline: "2026-09-26T12:00:00Z",
              timeEstimate: 20,
            },
          }),
        );
      }
      if (u.includes("/v0/status?")) return new Response(JSON.stringify(statusReply));
      return new Response("not found", { status: 404 });
    }),
  );
}

const matchingEcho = (amount = "5000000") => ({
  quoteResponse: {
    quoteRequest: { recipient: PAY_TO, destinationAsset: ASSET, amount, swapType: "EXACT_OUTPUT" },
  },
});

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  _resetAssetCache();
  lastQuoteBody = null;
  process.env.PAY_TO_ADDRESS = PAY_TO;
  process.env.ENABLE_NEAR_CREDITS = "true";
  delete process.env.NEAR_INTENTS_BASE_USDC_ASSET;
  mockOneClick();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const order = () => createNearOrder({ tier: "5", originAsset: "nep141:wrap.near", refundTo: "agent.near" });

describe("createNearOrder", () => {
  it("quotes an exact output of the pack price, in Base USDC, to our payTo", async () => {
    const o = await order();
    expect(lastQuoteBody).toMatchObject({
      dry: false,
      swapType: "EXACT_OUTPUT",
      destinationAsset: ASSET,
      amount: "5000000",
      recipient: PAY_TO,
      recipientType: "DESTINATION_CHAIN",
      originAsset: "nep141:wrap.near",
      refundTo: "agent.near",
      refundType: "ORIGIN_CHAIN",
    });
    expect(o.pay.depositAddress).toBe("deposit.near");
    expect(o.orderSecret).toMatch(/^nos_[0-9a-f]{48}$/);
    // the secret itself is never stored
    expect([...store.values()].join()).not.toContain(o.orderSecret);
  });

  it("rejects an unknown tier and a malformed asset before calling 1Click", async () => {
    await expect(createNearOrder({ tier: "7", originAsset: "nep141:wrap.near", refundTo: "a.near" })).rejects.toThrow(
      NearOrderError,
    );
    await expect(createNearOrder({ tier: "5", originAsset: "wNEAR", refundTo: "a.near" })).rejects.toThrow(/originAsset/);
    await expect(createNearOrder({ tier: "5", originAsset: "nep141:wrap.near", refundTo: "" })).rejects.toThrow(/refundTo/);
    expect(lastQuoteBody).toBeNull();
  });
});

describe("NEAR-rail specifics", () => {
  it("refuses a 64-hex implicit account with .near appended, naming the right form", async () => {
    const hex = "ee1f134939cb9ae3f330c2c5d92cf101edeaa8464f0bb848c98f3a5912ecfdaf";
    await expect(
      createNearOrder({ tier: "5", originAsset: "nep141:wrap.near", refundTo: `${hex}.near` }),
    ).rejects.toThrow(new RegExp(`use "${hex}"`));
    expect(lastQuoteBody).toBeNull();
    // named accounts and bare implicit accounts are fine
    await createNearOrder({ tier: "5", originAsset: "nep141:wrap.near", refundTo: hex });
    await createNearOrder({ tier: "5", originAsset: "nep141:wrap.near", refundTo: "alice.near" });
  });

  it("points a NEAR buyer at re-polling for recovery, and links the Base settlement", async () => {
    const o = await order();
    statusReply = {
      status: "SUCCESS",
      ...matchingEcho(),
      swapDetails: { destinationChainTxHashes: [{ hash: "0xabc", explorerUrl: "" }] },
    };
    const r = (await checkNearOrder(o.orderId, o.orderSecret)) as {
      security: string;
      settlement: { hash: string; explorerUrl: string }[];
    };
    expect(r.security).toMatch(/x-order-secret/);
    expect(r.security).not.toMatch(/recover/);
    expect(r.settlement).toEqual([{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }]);
    const again = (await checkNearOrder(o.orderId, o.orderSecret)) as { security: string };
    expect(again.security).toMatch(/x-order-secret/);
  });
});

describe("ASSET_RE", () => {
  // Real ids from 1Click's /v0/tokens (2026-09-26). The first version of the
  // pattern had no underscore and no `1cs_v1` prefix, so it turned away every
  // HOT-bridged asset (BNB, OP, AVAX, TON…) and every 1cs_v1 id.
  it.each([
    "nep141:wrap.near",
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
    "nep245:v2_1.omni.hot.tg:1117_",
    "1cs_v1:btc:native:coin",
    "1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f",
  ])("accepts %s", (id) => expect(ASSET_RE.test(id)).toBe(true));

  it.each(["wNEAR", "USDC", "erc20:0xabc", "nep141:", "nep141:a b"])("rejects %s", (id) =>
    expect(ASSET_RE.test(id)).toBe(false),
  );
});

describe("order storage", () => {
  it("trusts the write's own OK, not a read-back a replica may not have yet", async () => {
    // Production failed here: the GET went to a replica that had not seen the
    // SET yet. Creating an order must not depend on reading it back at all.
    const o = await order();
    expect(o.orderId).toMatch(/^[0-9a-f]{24}$/);
    expect(kvMock.kvGet).not.toHaveBeenCalled();
  });

  it("refuses to hand out a deposit address when the write was not acknowledged", async () => {
    kvMock.kvSetChecked.mockResolvedValueOnce({ ok: false, detail: "kv HTTP 429: ERR max requests limit exceeded" });
    // the reason travels with the refusal, so a failure can be diagnosed from the response
    await expect(order()).rejects.toMatchObject({ status: 503, message: expect.stringContaining("kv HTTP 429") });
  });
});

describe("checkNearOrder", () => {
  it("reports a pending swap without minting", async () => {
    const o = await order();
    statusReply = { status: "PENDING_DEPOSIT", ...matchingEcho() };
    const r = await checkNearOrder(o.orderId, o.orderSecret);
    expect(r.status).toBe("PENDING_DEPOSIT");
    expect(mintMock).not.toHaveBeenCalled();
  });

  it("mints once on SUCCESS and returns the same token on a repeat poll", async () => {
    const o = await order();
    statusReply = { status: "SUCCESS", ...matchingEcho(), swapDetails: { amountOut: "5000000" } };
    const first = (await checkNearOrder(o.orderId, o.orderSecret)) as { creditToken: string };
    const second = (await checkNearOrder(o.orderId, o.orderSecret)) as { creditToken: string; alreadyClaimed?: boolean };
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(mintMock).toHaveBeenCalledWith(550, 5);
    expect(second.creditToken).toBe(first.creditToken);
    expect(second.alreadyClaimed).toBe(true);
    // stored sealed, never in plaintext
    expect([...store.values()].join()).not.toContain(first.creditToken);
    expect(await nearRailLedger()).toMatchObject({ quotes: 1, packsSold: 1, paidUsd: 5 });
  });

  it("tells the owner about each sale exactly once", async () => {
    const o = await order();
    statusReply = {
      status: "SUCCESS",
      ...matchingEcho(),
      swapDetails: { amountOut: "5000000", destinationChainTxHashes: [{ hash: "0xfeed" }] },
    };
    await checkNearOrder(o.orderId, o.orderSecret);
    await checkNearOrder(o.orderId, o.orderSecret); // repeat poll: no second notice
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0]).toMatch(/\$5\.00 → \$5\.50[\s\S]*basescan\.org\/tx\/0xfeed/);
  });

  it("mints once when two polls race on SUCCESS", async () => {
    const o = await order();
    statusReply = { status: "SUCCESS", ...matchingEcho() };
    const results = await Promise.all([checkNearOrder(o.orderId, o.orderSecret), checkNearOrder(o.orderId, o.orderSecret)]);
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status).sort()).toEqual(["PROCESSING", "SUCCESS"]);
  });

  it("answers a wrong secret exactly like an unknown order", async () => {
    const o = await order();
    statusReply = { status: "SUCCESS", ...matchingEcho() };
    await expect(checkNearOrder(o.orderId, "nos_wrong")).rejects.toMatchObject({ status: 404 });
    await expect(checkNearOrder("f".repeat(24), o.orderSecret)).rejects.toMatchObject({ status: 404 });
    expect(mintMock).not.toHaveBeenCalled();
  });

  it("refuses to mint when the settled swap does not match the stored quote", async () => {
    const o = await order();
    statusReply = { status: "SUCCESS", ...matchingEcho("250000") };
    await expect(checkNearOrder(o.orderId, o.orderSecret)).rejects.toMatchObject({ status: 409 });
    statusReply = {
      status: "SUCCESS",
      quoteResponse: { quoteRequest: { ...matchingEcho().quoteResponse.quoteRequest, recipient: "0x" + "2".repeat(40) } },
    };
    await expect(checkNearOrder(o.orderId, o.orderSecret)).rejects.toMatchObject({ status: 409 });
    expect(mintMock).not.toHaveBeenCalled();
  });

  it("releases the mint lock when minting fails, so the next poll can mint", async () => {
    const o = await order();
    statusReply = { status: "SUCCESS", ...matchingEcho() };
    mintMock.mockRejectedValueOnce(new Error("ledger write failed"));
    await expect(checkNearOrder(o.orderId, o.orderSecret)).rejects.toMatchObject({ status: 503 });
    const r = (await checkNearOrder(o.orderId, o.orderSecret)) as { status: string; creditToken?: string };
    expect(r.status).toBe("SUCCESS");
    expect(r.creditToken).toMatch(/^ck_/);
  });

  it("reports a refund without minting", async () => {
    const o = await order();
    statusReply = { status: "REFUNDED", ...matchingEcho(), swapDetails: { refundedAmountFormatted: "2.0", refundReason: "late" } };
    const r = (await checkNearOrder(o.orderId, o.orderSecret)) as { status: string; refunded?: string };
    expect(r.status).toBe("REFUNDED");
    expect(r.refunded).toBe("2.0");
    expect(mintMock).not.toHaveBeenCalled();
  });
});

describe("flag off", () => {
  it("the routes answer 404 and never reach 1Click", async () => {
    process.env.ENABLE_NEAR_CREDITS = "false";
    const quote = await import("@/app/api/credits/near/quote/route");
    const status = await import("@/app/api/credits/near/status/route");
    const post = await quote.POST(
      new Request("https://x/api/credits/near/quote", { method: "POST", body: "{}" }) as never,
    );
    expect(post.status).toBe(404);
    expect(quote.GET().status).toBe(404);
    const st = await status.GET(new Request("https://x/api/credits/near/status?orderId=a") as never);
    expect(st.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
