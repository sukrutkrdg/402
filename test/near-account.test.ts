import { describe, it, expect, afterEach, vi } from "vitest";
import { nearAccount } from "@/lib/near-account";
import { _resetNearCaches } from "@/lib/near-rpc";
import { stubNear, CODE } from "./stubs/near-stub";

afterEach(() => {
  vi.unstubAllGlobals();
  _resetNearCaches();
});

const NEAR = (n: number) => (BigInt(n) * 10n ** 24n).toString();

describe("nearAccount", () => {
  it("a wallet held by one key: balances split into available and storage-locked", async () => {
    stubNear({ accounts: { "alice.near": { amount: NEAR(10), storage_usage: 100_000 } }, keys: { "alice.near": ["FullAccess"] } });
    const r = await nearAccount({ account: "alice.near" });
    expect(r).toMatchObject({
      exists: true,
      kind: "named",
      balance: { totalNear: "10", storageLockedNear: "1", availableNear: "9", stakedNear: "0" },
      contract: { deployed: false, isToken: false },
      control: { fullAccessKeys: 1, functionCallKeys: 0 },
    });
    expect(r.flags![0]).toMatch(/Wallet controlled by 1 full-access key\./);
  });

  it("lists function-call grants and flags an unlimited allowance", async () => {
    stubNear({
      accounts: { "bot.agent.near": { amount: NEAR(1) } },
      keys: { "bot.agent.near": ["FullAccess", "FullAccess", { FunctionCall: { allowance: null, receiver_id: "intents.near", method_names: [] } }] },
    });
    const r = await nearAccount({ account: "bot.agent.near" });
    expect(r).toMatchObject({ control: { fullAccessKeys: 2, functionCallKeys: 1, functionCallGrants: [{ contract: "intents.near", methods: "any", allowanceNear: "unlimited" }] } });
    expect(r.flags!.join(" ")).toMatch(/any one of them can move everything[\s\S]*unlimited gas allowance[\s\S]*Sub-account of agent\.near/);
  });

  it("recognises a locked token contract and points at near-token-safety", async () => {
    stubNear({ accounts: { "usdt.tether-token.near": { amount: NEAR(4564), code_hash: CODE } }, keys: {}, views: { "usdt.tether-token.near.ft_metadata": { symbol: "USDt", decimals: 6 } } });
    const r = await nearAccount({ account: "usdt.tether-token.near" });
    expect(r).toMatchObject({ contract: { deployed: true, isToken: true, symbol: "USDt" }, control: { fullAccessKeys: 0 } });
    expect(r.flags!.join(" ")).toMatch(/Locked contract[\s\S]*near-token-safety/);
  });

  it("flags an account nobody can sign for", async () => {
    stubNear({ accounts: { "dead.near": { amount: NEAR(3) } }, keys: {} });
    expect((await nearAccount({ account: "dead.near" })).flags![0]).toMatch(/stuck/);
  });

  it("explains a missing account differently for implicit and named ids", async () => {
    stubNear({ accounts: {} });
    const imp = "a".repeat(64);
    expect(await nearAccount({ account: imp })).toMatchObject({ exists: false, kind: "implicit" });
    expect((await nearAccount({ account: imp })).flags![0]).toMatch(/first funded/);
    expect((await nearAccount({ account: "ghost.near" })).flags![0]).toMatch(/would fail/);
  });

  it("rejects what is not a NEAR account id", async () => {
    const calls = stubNear({});
    await expect(nearAccount({ account: "Not An Account" })).rejects.toThrow(/NEAR account/);
    expect(calls).toEqual([]);
  });
});
