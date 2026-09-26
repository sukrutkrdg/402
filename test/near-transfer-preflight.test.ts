import { describe, it, expect, afterEach, vi } from "vitest";
import { nearTransferPreflight } from "@/lib/near-transfer-preflight";
import { _resetNearCaches } from "@/lib/near-rpc";
import { stubNear, CODE, type NearWorld } from "./stubs/near-stub";

afterEach(() => {
  vi.unstubAllGlobals();
  _resetNearCaches();
});

const T = "usdt.tether-token.near";
const registered = new Set(["alice.near", "bob.near"]);
const world = (extra: Partial<NearWorld> = {}): NearWorld => ({
  accounts: { [T]: { code_hash: CODE }, "alice.near": {}, "bob.near": {}, "carol.near": {} },
  views: {
    [`${T}.ft_metadata`]: { symbol: "USDt", decimals: 6 },
    [`${T}.storage_balance_of`]: (a: Record<string, unknown>) => (registered.has(String(a.account_id)) ? { total: "1250000000000000000000", available: "0" } : null),
    [`${T}.storage_balance_bounds`]: { min: "1250000000000000000000", max: "1250000000000000000000" },
    [`${T}.ft_balance_of`]: (a: Record<string, unknown>) => (a.account_id === "bob.near" ? "30000000" : "0"),
  },
  ...extra,
});

describe("nearTransferPreflight", () => {
  it("GO when the receiver is registered and the sender holds enough", async () => {
    stubNear(world());
    const r = await nearTransferPreflight({ token: T, to: "alice.near", from: "bob.near", amount: "25" });
    expect(r.verdict).toBe("GO");
    expect(r.fromBalance).toBe("30");
  });

  it("HOLD with the exact storage_deposit fix and its cost when the receiver is unregistered", async () => {
    stubNear(world());
    const r = await nearTransferPreflight({ token: T, to: "carol.near" });
    expect(r.verdict).toBe("HOLD");
    const c = r.checks.find((x) => x.check === "to registered")!;
    expect(c.detail).toMatch(/storage_deposit\(\{"account_id":"carol\.near","registration_only":true\}\)[\s\S]*0\.00125 NEAR/);
  });

  it("STOP when the sender holds too little", async () => {
    stubNear(world());
    const r = await nearTransferPreflight({ token: T, to: "alice.near", from: "bob.near", amount: "31" });
    expect(r.verdict).toBe("STOP");
    expect(r.checks.find((x) => x.check === "balance")!.detail).toMatch(/holds 30, less than 31/);
  });

  it("STOP for a named receiver that does not exist; an implicit one is creatable", async () => {
    stubNear(world());
    expect((await nearTransferPreflight({ token: T, to: "ghost.near" })).verdict).toBe("STOP");
    const imp = await nearTransferPreflight({ token: T, to: "b".repeat(64) });
    expect(imp.checks.find((x) => x.check === "to exists")!.result).toBe("GO");
    expect(imp.verdict).toBe("HOLD"); // still has to be registered
  });

  it("STOP when the token is paused, or is not a token at all", async () => {
    stubNear(world({ views: { ...world().views, [`${T}.paused`]: true } }));
    expect((await nearTransferPreflight({ token: T, to: "alice.near" })).verdict).toBe("STOP");
    stubNear(world());
    const r = await nearTransferPreflight({ token: "alice.near", to: "bob.near" });
    expect(r).toMatchObject({ verdict: "STOP", checks: [{ check: "token", result: "STOP" }] });
  });

  it("HOLD when sending to the token contract itself", async () => {
    stubNear(world({ views: { ...world().views, [`${T}.storage_balance_of`]: { total: "1", available: "0" } } }));
    const r = await nearTransferPreflight({ token: T, to: T });
    expect(r.verdict).toBe("HOLD");
    expect(r.checks.some((c) => /token contract itself/.test(c.detail))).toBe(true);
  });

  it("rejects bad input before any network call", async () => {
    const calls = stubNear({});
    await expect(nearTransferPreflight({ token: "0x" + "a".repeat(40), to: "alice.near" })).rejects.toThrow(/EVM address/);
    await expect(nearTransferPreflight({ token: T })).rejects.toThrow(/to is required/);
    expect(calls).toEqual([]);
  });
});
