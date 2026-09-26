import { describe, it, expect, vi, afterEach } from "vitest";
import { nearTokenSafety, NEAR_ACCOUNT_RE } from "@/lib/near-token-safety";

/**
 * The verdict turns on one thing: who can replace the contract. These pin each
 * branch against the NEAR RPC's real response shapes, and the RPC fallback.
 */

const CODE = "E8jZ1giWcVrps8PcV75ATauu6gFRkcwjNtKp7NKmipZG";
const enc = (v: unknown) => Array.from(Buffer.from(JSON.stringify(v)));

interface World {
  account?: { amount: string; code_hash: string; storage_usage: number } | "unknown";
  keys?: ("FullAccess" | "FunctionCall")[];
  metadata?: unknown;
  supply?: string;
  tokens?: { assetId: string; blockchain: string; contractAddress?: string; price?: number }[];
  firstRpcDown?: boolean;
  /** view method → JSON answer; methods not listed fail like a missing method. */
  views?: Record<string, unknown>;
}

function stub(w: World) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("1click")) return new Response(JSON.stringify(w.tokens ?? []));
      if (w.firstRpcDown && u.includes("fastnear")) return new Response("bad gateway", { status: 502 });
      const p = JSON.parse(String(init?.body)).params;
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "402", result }));
      if (p.request_type === "view_account") {
        if (w.account === "unknown")
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: "402", error: { cause: { name: "UNKNOWN_ACCOUNT" }, message: "Server error" } }));
        return ok(w.account);
      }
      if (p.request_type === "view_access_key_list")
        return ok({ keys: (w.keys ?? []).map((k, i) => ({ public_key: `ed25519:${i}`, access_key: { nonce: 1, permission: k === "FullAccess" ? "FullAccess" : { FunctionCall: { receiver_id: "x", method_names: [] } } } })) });
      if (p.request_type === "call_function") {
        if (p.method_name === "ft_metadata")
          return w.metadata ? ok({ result: enc(w.metadata), logs: [] }) : ok({ error: "wasm execution failed: MethodNotFound", logs: [] });
        if (p.method_name === "ft_total_supply") return ok({ result: enc(w.supply ?? "0"), logs: [] });
        if (w.views && p.method_name in w.views) return ok({ result: enc(w.views[p.method_name]), logs: [] });
        return ok({ error: "wasm execution failed: MethodNotFound", logs: [] });
      }
      return new Response("?", { status: 400 });
    }),
  );
  return calls;
}

const TOKEN = { amount: "5000000000000000000000000", code_hash: CODE, storage_usage: 1234 };
const META = { spec: "ft-1.0.0", name: "Tether USD", symbol: "USDt", decimals: 6 };

afterEach(() => vi.unstubAllGlobals());

describe("nearTokenSafety", () => {
  it("HOLD when full-access keys can redeploy the contract", async () => {
    stub({ account: TOKEN, keys: ["FullAccess", "FullAccess", "FunctionCall"], metadata: META, supply: "1500000000", tokens: [{ assetId: "nep141:usdt.tether-token.near", blockchain: "near", contractAddress: "usdt.tether-token.near", price: 1 }] });
    const r = await nearTokenSafety({ token: "usdt.tether-token.near" });
    expect(r.verdict).toBe("HOLD");
    expect(r).toMatchObject({
      control: { fullAccessKeys: 2, functionCallKeys: 1, upgradeableByKey: true },
      metadata: { symbol: "USDt", decimals: 6 },
      totalSupply: { formatted: "1500" },
      market: { nearIntents: { listed: true, priceUsd: 1 } },
    });
    expect(r.checkedAt).toBeTruthy();
  });

  it("GO when locked (no full-access key), with the caveat stated", async () => {
    stub({ account: TOKEN, keys: ["FunctionCall"], metadata: META, supply: "1" });
    const r = await nearTokenSafety({ token: "locked.near" });
    expect(r.verdict).toBe("GO");
    expect(r.reasons.join(" ")).toMatch(/does not read the contract's source/);
    expect(r.reasons.join(" ")).toMatch(/Not routed by NEAR Intents/);
  });

  it("HOLD when there are no keys but the contract names an owner — the USDt case", async () => {
    stub({ account: TOKEN, keys: [], metadata: META, supply: "1", views: { owner_id: "tether-treasury.near" } });
    const r = await nearTokenSafety({ token: "usdt.tether-token.near" });
    expect(r.verdict).toBe("HOLD");
    expect(r).toMatchObject({ control: { fullAccessKeys: 0, owner: "tether-treasury.near", ownerMethod: "owner_id", paused: null } });
    expect(r.reasons[0]).toMatch(/Owner-controlled/);
  });

  it("reads an owner returned as an object, and reports an existing pause switch", async () => {
    stub({ account: TOKEN, keys: [], metadata: META, supply: "1", views: { get_owner: { owner_id: "dao.sputnik-dao.near" }, is_paused: false } });
    const r = await nearTokenSafety({ token: "x.near" });
    expect(r).toMatchObject({ verdict: "HOLD", control: { owner: "dao.sputnik-dao.near", paused: false } });
    expect(r.reasons.join(" ")).toMatch(/pause switch exists/);
  });

  it("STOP when the contract says it is paused", async () => {
    stub({ account: TOKEN, keys: [], metadata: META, supply: "1", views: { paused: true } });
    const r = await nearTokenSafety({ token: "x.near" });
    expect(r.verdict).toBe("STOP");
    expect(r.reasons[0]).toMatch(/Paused/);
  });

  it("STOP for an account with no contract, and for a contract that is not NEP-141", async () => {
    stub({ account: { ...TOKEN, code_hash: "11111111111111111111111111111111" } });
    expect((await nearTokenSafety({ token: "alice.near" })).verdict).toBe("STOP");
    stub({ account: TOKEN, keys: [], metadata: undefined });
    const r = await nearTokenSafety({ token: "some-dapp.near" });
    expect(r.verdict).toBe("STOP");
    expect(r.reasons[0]).toMatch(/ft_metadata/);
  });

  it("STOP for an account that does not exist", async () => {
    stub({ account: "unknown" });
    expect(await nearTokenSafety({ token: "nobody-here.near" })).toMatchObject({ exists: false, verdict: "STOP" });
  });

  it("falls back to the next RPC when the first one is down", async () => {
    const calls = stub({ account: TOKEN, keys: [], metadata: META, supply: "1", firstRpcDown: true });
    expect((await nearTokenSafety({ token: "wrap.near" })).verdict).toBe("GO");
    expect(calls.some((u) => u.includes("rpc.mainnet.near.org"))).toBe(true);
  });

  it("rejects input that is not a NEAR account, before any network call", async () => {
    const calls = stub({});
    await expect(nearTokenSafety({ token: "0xdAC17F958D2ee523a2206206994597C13D831ec7" })).rejects.toThrow(/EVM address[\s\S]*token-risk/);
    await expect(nearTokenSafety({ token: "Bad..Name" })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("accepts the account shapes 1Click lists", () => {
    for (const id of ["wrap.near", "usdt.tether-token.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "853d955acef822db058eb8505911ed77f175b99e.factory.bridge.near", "abg-966.meme-cooking.near"])
      expect(NEAR_ACCOUNT_RE.test(id), id).toBe(true);
  });
});
