import { describe, it, expect, afterEach, vi } from "vitest";
import { nearTokenHolders } from "@/lib/near-token-holders";
import { _resetNearCaches } from "@/lib/near-rpc";
import { _resetNearblocksCache } from "@/lib/nearblocks";
import { stubNear, CODE } from "./stubs/near-stub";

afterEach(() => {
  vi.unstubAllGlobals();
  _resetNearCaches();
  _resetNearblocksCache();
});

/** stubNear for the RPC, plus NearBlocks answers for the indexer paths. */
function world(holders: { account: string; amount: string }[], opts: { count?: number; contracts?: string[] } = {}) {
  const accounts: Record<string, { code_hash?: string }> = { "tok.near": { code_hash: CODE } };
  for (const h of holders) accounts[h.account] = opts.contracts?.includes(h.account) ? { code_hash: CODE } : {};
  stubNear({
    accounts,
    views: { "tok.near.ft_metadata": { name: "Tok", symbol: "TOK", decimals: 2 }, "tok.near.ft_total_supply": "100000" },
  });
  const rpc = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/holders/count")) return new Response(JSON.stringify({ holders: [{ count: String(opts.count ?? 1000) }] }));
      if (u.includes("/holders")) return new Response(JSON.stringify({ holders }));
      return rpc(u, init);
    }),
  );
}

describe("nearTokenHolders", () => {
  it("a whale account makes concentration HIGH; shares are of total supply", async () => {
    world([
      { account: "whale.near", amount: "60000" },
      { account: "bob.near", amount: "10000" },
    ]);
    const r = await nearTokenHolders({ token: "tok.near" });
    expect(r).toMatchObject({
      symbol: "TOK",
      totalSupply: "1000",
      holderCount: 1000,
      concentration: "HIGH",
      shares: { top1Pct: 60, top10Pct: 70, top1AccountPctOfCirculating: 60 },
      holders: [
        { rank: 1, account: "whale.near", type: "account", balance: "600", sharePct: 60 },
        { rank: 2, account: "bob.near", balance: "100", sharePct: 10 },
      ],
    });
  });

  it("a pool holding most of the supply is not a whale", async () => {
    world(
      [
        { account: "v2.ref-finance.near", amount: "70000" },
        { account: "bob.near", amount: "5000" },
      ],
      { contracts: ["v2.ref-finance.near"] },
    );
    const r = await nearTokenHolders({ token: "tok.near" });
    expect(r.concentration).toBe("LOW");
    expect(r.holders[0]).toMatchObject({ type: "contract", sharePct: 70 });
    expect(r.signals.join(" ")).toMatch(/largest holder is a contract/);
  });

  it("an issuer treasury is not a whale: concentration is over circulating supply", async () => {
    world([
      { account: "tok-treasury.near", amount: "90000" },
      { account: "bob.near", amount: "1000" },
      { account: "carol.near", amount: "1000" },
    ]);
    const r = await nearTokenHolders({ token: "tok.near" });
    expect(r.holders[0]).toMatchObject({ type: "treasury", sharePct: 90 });
    expect(r.circulatingSupply).toBe("100");
    expect(r.shares).toMatchObject({ top1Pct: 90, top1AccountPctOfCirculating: 10, top10AccountsPctOfCirculating: 20 });
    expect(r.concentration).toBe("LOW");
    expect(r.signals.join(" ")).toMatch(/treasury: unissued stock/);
  });

  it("refuses EVM addresses and non-tokens", async () => {
    world([]);
    await expect(nearTokenHolders({ token: "0x" + "a".repeat(40) })).rejects.toThrow(/EVM address/);
    await expect(nearTokenHolders({ token: "bob.near" })).rejects.toThrow(/does not exist|not a NEP-141/);
  });
});
