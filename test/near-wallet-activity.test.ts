import { describe, it, expect, afterEach, vi } from "vitest";
import { nearWalletActivity } from "@/lib/near-wallet-activity";
import { _resetNearCaches } from "@/lib/near-rpc";
import { _resetNearblocksCache } from "@/lib/nearblocks";

afterEach(() => {
  vi.unstubAllGlobals();
  _resetNearCaches();
  _resetNearblocksCache();
});

const NS = (iso: string) => `${Date.parse(iso)}000000`;
const Y = (n: number) => (BigInt(n) * 10n ** 24n).toString();

function stubIndexer(routes: Record<string, unknown>, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      const hit = Object.keys(routes).find((k) => u.includes(k));
      return hit ? new Response(JSON.stringify(routes[hit]), { status }) : new Response("{}", { status: 404 });
    }),
  );
  return calls;
}

describe("nearWalletActivity", () => {
  it("sums NEAR and token flows, counterparties and calls into a summary", async () => {
    const now = new Date().toISOString();
    const calls = stubIndexer({
      "/txns-only": {
        txns: [
          { transaction_hash: "h1", signer_account_id: "alice.near", receiver_account_id: "bob.near", block_timestamp: NS(now),
            actions: [{ action: "TRANSFER", method: null, deposit: Y(3) }], actions_agg: { deposit: Y(3) }, outcomes: { status: true } },
          { transaction_hash: "h2", signer_account_id: "carol.near", receiver_account_id: "alice.near", block_timestamp: NS(now),
            actions: [{ action: "TRANSFER", method: null, deposit: Y(1) }], actions_agg: { deposit: Y(1) }, outcomes: { status: true } },
          { transaction_hash: "h3", signer_account_id: "alice.near", receiver_account_id: "v2.ref-finance.near", block_timestamp: NS(now),
            actions: [{ action: "FUNCTION_CALL", method: "swap", deposit: "1" }], actions_agg: { deposit: "1" }, outcomes: { status: false } },
        ],
      },
      "/ft-txns": {
        txns: [
          { transaction_hash: "h4", involved_account_id: "bob.near", delta_amount: "-5000000", cause: "TRANSFER", block_timestamp: NS(now),
            ft: { contract: "usdt.tether-token.near", symbol: "USDt", decimals: 6 } },
          { transaction_hash: "h5", involved_account_id: "bob.near", delta_amount: "2500000", cause: "TRANSFER", block_timestamp: NS(now),
            ft: { contract: "usdt.tether-token.near", symbol: "USDt", decimals: 6 } },
        ],
      },
    });
    const r = await nearWalletActivity({ account: "Alice.near" });
    expect(calls[0]).toContain("/v1/account/alice.near/txns-only?per_page=25&order=desc");
    expect(r).toMatchObject({
      account: "alice.near",
      window: { transactions: 3, tokenTransfers: 2 },
      near: { sent: "3", received: "1" },
      tokenFlows: [{ symbol: "USDt", received: "2.5", sent: "5", net: "-2.5", transfers: 2 }],
      topCalls: [{ call: "v2.ref-finance.near.swap", times: 1 }],
    });
    expect(r.topCounterparties[0]).toMatchObject({ account: "bob.near", interactions: 3 });
    expect(r.recent[0]).toMatchObject({ hash: "h1", direction: "out", counterparty: "bob.near", nearAmount: "3", success: true });
    expect(r.summary).toMatch(/3 recent transactions \(2 signed, 1 received, 1 failed\)/);
  });

  it("an account with no history says so", async () => {
    stubIndexer({ "/txns-only": { txns: [] }, "/ft-txns": { txns: [] } });
    const r = await nearWalletActivity({ account: "ghost.near" });
    expect(r.summary).toBe("No activity found.");
    expect(r.signals[0]).toMatch(/No transactions/);
  });

  it("indexer rate limit is a not-charged error", async () => {
    stubIndexer({ "/txns-only": {}, "/ft-txns": {} }, 429);
    await expect(nearWalletActivity({ account: "alice.near" })).rejects.toThrow(/rate limit — not charged/);
  });

  it("rejects bad input before calling out", async () => {
    const calls = stubIndexer({});
    await expect(nearWalletActivity({ account: "not valid" })).rejects.toThrow(/NEAR account/);
    await expect(nearWalletActivity({ account: "alice.near", limit: "500" })).rejects.toThrow(/limit/);
    expect(calls).toEqual([]);
  });
});
