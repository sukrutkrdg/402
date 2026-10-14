import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * clanker-token-audit, replayed against real responses recorded from Base
 * (public RPC) and clanker.world on 2026-10-14: test/fixtures/clanker-audit.json.
 * Receipts are trimmed to the logs the Clanker factories emitted; everything
 * else is byte-for-byte what the chain returned.
 *
 * The previous version of this service called $CLANKER an impersonator and
 * failed every real v4 token. These pin the opposite.
 */
type Rec = Record<string, unknown>;
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/clanker-audit.json", import.meta.url), "utf8")) as Rec;

const des = (v: unknown): unknown =>
  v && typeof v === "object" && "$big" in (v as Rec)
    ? BigInt((v as { $big: string }).$big)
    : Array.isArray(v) ? v.map(des) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, des(x)])) : v;
const ser = (v: unknown): unknown =>
  typeof v === "bigint" ? { $big: v.toString() } : Array.isArray(v) ? v.map(ser) : v;

const state = vi.hoisted(() => ({ fixture: {} as Record<string, unknown>, rpcDown: false, apiDown: false }));

vi.mock("viem", async (orig) => {
  const actual = await orig<typeof import("viem")>();
  const miss = (k: string) => new Error(`no recorded response for ${k}`);
  return {
    ...actual,
    createPublicClient: () => ({
      getCode: async ({ address }: { address: string }) => {
        if (state.rpcDown) throw new Error("HTTP request failed");
        const k = `code:${address.toLowerCase()}`;
        if (!(k in state.fixture)) throw miss(k);
        return state.fixture[k];
      },
      readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: unknown[] }) => {
        if (state.rpcDown) throw new Error("HTTP request failed");
        const k = `${address.toLowerCase()}:${functionName}:${JSON.stringify((args ?? []).map(ser))}`;
        const r = state.fixture[k] as { ok?: unknown; revert?: boolean } | undefined;
        if (!r) throw miss(k);
        if (r.revert) throw new Error("execution reverted");
        return des(r.ok);
      },
      getTransactionReceipt: async ({ hash }: { hash: string }) => {
        if (state.rpcDown) throw new Error("HTTP request failed");
        const k = `receipt:${hash.toLowerCase()}`;
        if (!(k in state.fixture)) throw miss(k);
        return state.fixture[k];
      },
    }),
  };
});

const realFetch = globalThis.fetch;
beforeEach(() => {
  state.fixture = structuredClone(FIXTURE);
  state.rpcDown = false;
  state.apiDown = false;
  globalThis.fetch = (async (url: string) => {
    if (state.apiDown) throw new Error("ECONNRESET");
    const q = new URL(String(url)).searchParams.get("q")!.toLowerCase();
    const body = state.fixture[`api:${q}`];
    if (!body) throw new Error(`no recorded clanker.world response for ${q}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
});

import { clankerTokenAudit } from "@/lib/clanker-audit";

const V4_TOKEN = "0x6eC3e73EDdCAE1bF5E29C5BE627d0B153701CB07";
const CLANKER = "0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb";
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const EOA = "0x000000000000000000000000000000000000dEaD";
const V4_LOCKER = "0xffA37784D619F228D8B379d287a4D7282e500762";

describe("clanker-token-audit", () => {
  it("verifies a real Clanker v4 token from the factory's own record", async () => {
    const r = await clankerTokenAudit({ address: V4_TOKEN });
    expect(r.verdict).toBe("clanker_verified");
    expect(r.clankerVersion).toBe("v4");
    expect(r.factory).toBe("0xE85A59c628F7d27878ACeB4bf3b35733630083a9");
    expect(r.evidence).toMatch(/tokenDeploymentInfo/);
    // requester = originalAdmin set at deploy
    expect((r.deployment as Rec).requestor).toBe("0x969Aae1a54e76E8E3cB090B26883eaB11F41C725");
    // all LP position NFTs sit in the reviewed v4 locker
    expect(r.liquidityLocked).toBe(true);
    expect(r.liquidity?.locker).toBe(V4_LOCKER);
    expect(r.liquidity?.lpPositionIds.length).toBe(5);
    // the poolId we derive from the locker's poolKey is the one clanker.world lists
    const api = (FIXTURE[`api:${V4_TOKEN.toLowerCase()}`] as { data: { pool_address: string }[] }).data[0];
    expect((r.liquidity?.pool as Rec).poolId).toBe(api.pool_address);
    expect(r.clankerWorld.agreesWithOnchain).toBe(true);
    expect(r.receipt.confidence.band).toBe("high");
    expect(r.receipt.refundable).toBe(false);
  });

  it("verifies $CLANKER as a v0 launch and never calls it an impersonator", async () => {
    const r = await clankerTokenAudit({ address: CLANKER });
    expect(r.verdict).toBe("clanker_verified");
    expect(r.isClanker).toBe(true);
    expect(r.clankerVersion).toBe("v0");
    expect(r.evidence).toMatch(/emitted TokenCreated/);
    expect((r.deployment as Rec).farcasterFid).toBe("270504");
    expect(JSON.stringify(r)).not.toMatch(/scam|impersonat/i);
    expect(r).not.toHaveProperty("claimsClanker");
    // LP NFT left the deploy-time time lock; we report where it is, not a guess.
    expect(r.liquidityLocked).toBeNull();
    expect(r.liquidity?.lpHolders).toEqual(["0xce0B18f82AA5a1BB67e30aA7C2ABa46d21F662cC"]);
  });

  it("answers not_clanker for a token no Clanker factory deployed", async () => {
    const r = await clankerTokenAudit({ address: DEGEN });
    expect(r.verdict).toBe("not_clanker");
    expect(r.isClanker).toBe(false);
    expect(r.clankerVersion).toBeNull();
    expect(r.claimsClanker).toBe(false);
    expect(r.liquidityLocked).toBeNull();
    expect(r.receipt.confidence.band).toBe("high");
  });

  it("answers not_clanker for an address with no code", async () => {
    const r = await clankerTokenAudit({ address: EOA });
    expect(r.verdict).toBe("not_clanker");
    expect(r.isContract).toBe(false);
  });

  it("phrases a Clanker-named non-Clanker token as an unbacked claim, not a scam", async () => {
    state.fixture[`${DEGEN.toLowerCase()}:symbol:[]`] = { ok: "CLANKER" };
    const r = await clankerTokenAudit({ address: DEGEN });
    expect(r.verdict).toBe("not_clanker");
    expect(r.claimsClanker).toBe(true);
    expect(r.recommendation).toMatch(/no Clanker deployment record/);
    expect(r.recommendation).not.toMatch(/scam|impersonat/i);
  });

  it("does not call liquidity locked when a position has left the locker", async () => {
    state.fixture['0x7c5f5a4bbd8fd63184577525326123b519429bdc:ownerOf:[{"$big":"3135385"}]'] = { ok: "0x1111111111111111111111111111111111111111" };
    const r = await clankerTokenAudit({ address: V4_TOKEN });
    expect(r.verdict).toBe("clanker_verified");
    expect(r.liquidityLocked).toBe(false);
  });

  it("throws (not charged) when the Base RPC is down", async () => {
    state.rpcDown = true;
    await expect(clankerTokenAudit({ address: V4_TOKEN })).rejects.toThrow(/not charged/);
    await expect(clankerTokenAudit({ address: DEGEN })).rejects.toThrow(/not charged/);
  });

  it("still answers from the chain when clanker.world is down, at lower confidence", async () => {
    state.apiDown = true;
    const r = await clankerTokenAudit({ address: DEGEN });
    expect(r.verdict).toBe("not_clanker");
    expect(r.clankerWorld.consulted).toBe(false);
    expect(r.receipt.confidence.band).toBe("medium");
    const v4 = await clankerTokenAudit({ address: V4_TOKEN });
    expect(v4.verdict).toBe("clanker_verified");
  });

  it("throws (not charged) for v0 bytecode when the deploy record cannot be fetched", async () => {
    // v0/v1 factories kept no per-token record; without the deploy tx we cannot
    // confirm, and must not answer either way.
    state.apiDown = true;
    await expect(clankerTokenAudit({ address: CLANKER })).rejects.toThrow(/not charged/);
  });

  it("refuses (not billed) when legacy bytecode has no listed deploy transaction", async () => {
    state.fixture[`api:${CLANKER.toLowerCase()}`] = { data: [] };
    const r = await clankerTokenAudit({ address: CLANKER });
    expect(r.verdict).toBe("unknown");
    expect(r.receipt.refundable).toBe(true);
  });

  it("rejects a malformed address before any read", async () => {
    await expect(clankerTokenAudit({ address: "0x123" })).rejects.toThrow(/valid 0x/);
  });
});
