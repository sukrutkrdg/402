import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * pre-trade-bundle, run END TO END through its real dependencies.
 *
 * The version this replaces billed EXECUTE/100 with every sub-check failed,
 * because it read field names its dependencies never return — a mocked
 * dependency would have returned whatever the bundle expected, and its tests
 * passed. So here nothing the bundle reads is mocked: pre-trade-gate,
 * token-risk, b20-gate, owner-powers, dump-risk, clanker-token-audit and the
 * GoPlus/DexScreener fetchers all run for real. Only the wire is replaced:
 *
 *   - fetch: GoPlus / DexScreener / clanker.world answers per scenario
 *   - viem's public client: B20 precompile multicall per scenario; the Clanker
 *     factory, bytecode and token reads replayed from the responses recorded
 *     from Base for clanker-audit.test.ts (test/fixtures/clanker-audit.json)
 *   - sellability / swap-route / deployer-rep: the gate's own sub-checks, which
 *     need keyed providers; stubbed with what each returns in that scenario
 *     (their contract with the gate is covered in gate.test.ts)
 */
type Rec = Record<string, unknown>;
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/clanker-audit.json", import.meta.url), "utf8")) as Rec;
const des = (v: unknown): unknown =>
  v && typeof v === "object" && "$big" in (v as Rec)
    ? BigInt((v as { $big: string }).$big)
    : Array.isArray(v) ? v.map(des) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, des(x)])) : v;
const ser = (v: unknown): unknown => (typeof v === "bigint" ? { $big: v.toString() } : Array.isArray(v) ? v.map(ser) : v);

type Mc = { status: "success"; result: unknown } | { status: "failure"; error: Error };
const state = vi.hoisted(() => ({
  rpcDown: false,
  b20: [] as unknown[],
  b20Down: false,
  goplus: null as Record<string, unknown> | null | "down",
  pairs: [] as unknown[] | "down",
  clankerApiDown: false,
}));

vi.mock("viem", async (orig) => {
  const actual = await orig<typeof import("viem")>();
  const revert = () => new Error("execution reverted");
  const down = () => new Error("HTTP request failed");
  return {
    ...actual,
    createPublicClient: () => ({
      getCode: async ({ address }: { address: string }) => {
        if (state.rpcDown) throw down();
        return (FIXTURE[`code:${address.toLowerCase()}`] as string | undefined) ?? "0x6080604052";
      },
      getBlockNumber: async () => {
        if (state.rpcDown) throw down();
        return 30_000_000n;
      },
      getStorageAt: async () => {
        if (state.rpcDown) throw down();
        return "0x0000000000000000000000000000000000000000000000000000000000000000";
      },
      readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: unknown[] }) => {
        if (state.rpcDown) throw down();
        const r = FIXTURE[`${address.toLowerCase()}:${functionName}:${JSON.stringify((args ?? []).map(ser))}`] as { ok?: unknown; revert?: boolean } | undefined;
        if (r) {
          if (r.revert) throw revert();
          return des(r.ok);
        }
        if (functionName === "decimals") return 18;
        if (functionName === "totalSupply") return 10n ** 27n;
        if (functionName === "symbol") return "TKN";
        if (functionName === "name") return "Token";
        throw revert(); // owner()/getOwner() absent, unknown views revert
      },
      getTransactionReceipt: async ({ hash }: { hash: string }) => {
        if (state.rpcDown) throw down();
        return FIXTURE[`receipt:${hash.toLowerCase()}`];
      },
      multicall: async () => {
        if (state.rpcDown || state.b20Down) throw down();
        return state.b20 as Mc[];
      },
    }),
  };
});

const { sellabilityMock, swapRouteMock, deployerMock } = vi.hoisted(() => ({
  sellabilityMock: vi.fn(),
  swapRouteMock: vi.fn(),
  deployerMock: vi.fn(),
}));
vi.mock("@/lib/sellability", () => ({ sellability: sellabilityMock }));
vi.mock("@/lib/swap-route", () => ({ swapRoute: swapRouteMock }));
vi.mock("@/lib/deployer-rep", () => ({ deployerReputation: deployerMock }));

import { preTradeBundle } from "@/lib/pre-trade-bundle";
import { preTradeGate } from "@/lib/gate";
import { b20Gate } from "@/lib/b20-safety";
import { ownerPowers } from "@/lib/owner-powers";
import { dumpRiskCore } from "@/lib/dump-risk";
import { clankerTokenAudit } from "@/lib/clanker-audit";
import { isRefundable } from "@/lib/envelope";

const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"; // recorded: not a Clanker launch
const V4_TOKEN = "0x6eC3e73EDdCAE1bF5E29C5BE627d0B153701CB07"; // recorded: Clanker v4, LP locked
const CLANKER = "0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb"; // recorded: Clanker v0 bytecode
const ZERO = "0x0000000000000000000000000000000000000000";

const ok = (result: unknown): Mc => ({ status: "success", result });
const fail = (): Mc => ({ status: "failure", error: new Error("execution reverted") });
/** readB20Signals' multicall order: supplyCap, symbol, multiplier, sender, receiver,
 *  pause0..2, executor, mintReceiver, factory.isB20, seizeHolder, seizeReceiver, pauseSeize. */
const NOT_B20: Mc[] = [fail(), fail(), fail(), fail(), fail(), fail(), fail(), fail(), fail(), fail(), ok(false), fail(), fail(), fail()];
const B20_SEIZE_ARMED: Mc[] = [ok(10n ** 30n), ok("SEIZ"), fail(), ok(0n), ok(0n), ok(false), ok(false), ok(false), ok(0n), ok(0n), ok(true), ok(7n), ok(0n), ok(false)];

/** A complete GoPlus row for a clean token: renounced, open source, no powers, spread holders. */
function cleanGoPlus(): Record<string, unknown> {
  return {
    is_honeypot: "0", buy_tax: "0", sell_tax: "0", cannot_sell_all: "0", transfer_pausable: "0",
    is_mintable: "0", is_open_source: "1", is_proxy: "0", owner_address: ZERO, hidden_owner: "0",
    can_take_back_ownership: "0", is_blacklisted: "0", slippage_modifiable: "0", is_in_dex: "1",
    holder_count: "52000",
    holders: [
      { address: "0x1111111111111111111111111111111111111111", percent: "0.01", is_contract: 0, is_locked: 0, tag: "" },
      { address: "0x2222222222222222222222222222222222222222", percent: "0.008", is_contract: 0, is_locked: 0, tag: "" },
    ],
  };
}
const deepPools = (token: string) => [
  { chainId: "base", baseToken: { address: token.toLowerCase() }, priceUsd: "0.01", liquidity: { usd: 4_000_000 }, marketCap: 10_000_000 },
];

const realFetch = globalThis.fetch;
function wire(token: string) {
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "api.gopluslabs.io") {
      if (state.goplus === "down") throw new Error("ECONNRESET");
      return new Response(JSON.stringify({ code: 1, result: state.goplus ? { [token.toLowerCase()]: state.goplus } : {} }), { status: 200 });
    }
    if (url.hostname === "api.dexscreener.com") {
      if (state.pairs === "down") return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ pairs: state.pairs }), { status: 200 });
    }
    if (url.hostname === "www.clanker.world") {
      if (state.clankerApiDown) throw new Error("ECONNRESET");
      const q = url.searchParams.get("q")!.toLowerCase();
      return new Response(JSON.stringify(FIXTURE[`api:${q}`] ?? { data: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url.hostname}`);
  }) as typeof fetch;
}

/** The gate's sub-checks as they answer when GoPlus answered (clean token). */
function gateSubchecksClean() {
  sellabilityMock.mockResolvedValue({ canSell: true, sellTaxPct: 0 });
  swapRouteMock.mockResolvedValue({ estPriceImpactPct: 0.1, verdict: "ok", safetyChecked: true });
  deployerMock.mockResolvedValue({ reputation: "trusted", reputationScore: 90 });
}

type Bundle = Awaited<ReturnType<typeof preTradeBundle>>;

beforeEach(() => {
  vi.clearAllMocks();
  state.rpcDown = false;
  state.b20 = NOT_B20;
  state.b20Down = false;
  state.goplus = cleanGoPlus();
  state.pairs = deepPools(DEGEN);
  state.clankerApiDown = false;
  wire(DEGEN);
  gateSubchecksClean();
  return () => {
    globalThis.fetch = realFetch;
  };
});

describe("pre-trade-bundle — decisions, end to end", () => {
  it("clean token with every check ok → GO, billed, with a real size", async () => {
    const r: Bundle = await preTradeBundle({ address: DEGEN, amountUsd: "1000" });
    expect(r.decision).toBe("GO");
    expect(r.checks.preTradeGate.status).toBe("clean");
    expect(r.checks.ownerPowers.status).toBe("clean");
    expect(r.checks.dumpRisk.status).toBe("clean");
    expect(r.unverified).toEqual([]);
    expect(isRefundable(r)).toBe(false);
    expect(r.receipt.confidence.band).toBe("high");
    // 2% constant-product size against $4M aggregate liquidity (reserve $2M).
    expect(r.sizing.recommendedMaxSizeUsd).toBe(Math.floor((0.02 * 2_000_000) / 0.98));
    expect(r.sizing.withinRecommended).toBe(true);
  });

  it("non-B20 token: b20-gate is N/A and does not block GO", async () => {
    const r = await preTradeBundle({ address: DEGEN });
    expect(r.checks.b20Gate.status).toBe("not_applicable");
    expect(r.checks.b20Gate.decision).toBe("N/A");
    expect(r.decision).toBe("GO");
  });

  it("not_clanker does not lower the decision", async () => {
    const r = await preTradeBundle({ address: DEGEN });
    expect(r.checks.clankerTokenAudit.decision).toBe("not_clanker");
    expect(r.decision).toBe("GO");
  });

  it("honeypot → STOP (billed: a complete read with a terminal flag)", async () => {
    state.goplus = { ...cleanGoPlus(), is_honeypot: "1" };
    sellabilityMock.mockResolvedValue({ canSell: false, sellTaxPct: 0 });
    const r = await preTradeBundle({ address: DEGEN });
    expect(r.decision).toBe("STOP");
    expect(r.checks.preTradeGate.status).toBe("stop");
    expect(r.observedRisks.join(" ")).toMatch(/pre-trade-gate/);
    expect(r.sizing.recommendedMaxSizeUsd).toBeNull();
    expect(isRefundable(r)).toBe(false);
  });

  it("B20 with an armed seize policy → STOP", async () => {
    state.b20 = B20_SEIZE_ARMED;
    const r = await preTradeBundle({ address: DEGEN });
    expect(r.checks.b20Gate.status).toBe("stop");
    expect(r.decision).toBe("STOP");
    expect(r.observedRisks.join(" ")).toMatch(/seize/i);
  });

  it("GoPlus partial row (no is_honeypot) → HOLD, never GO, not billed", async () => {
    // What GoPlus sends while it is still analysing a token (code 3).
    const { is_honeypot: _drop, ...partial } = cleanGoPlus();
    void _drop;
    state.goplus = partial;
    // What the gate's sub-checks return without a security feed.
    sellabilityMock.mockResolvedValue({ canSell: null, degraded: true, sellTaxPct: null });
    swapRouteMock.mockResolvedValue({ estPriceImpactPct: 0.1, verdict: "ok", safetyChecked: false });
    const r = await preTradeBundle({ address: DEGEN });
    expect(r.decision).toBe("HOLD");
    expect(r.unverified.map((u) => u.check)).toEqual(expect.arrayContaining(["pre-trade-gate", "owner-powers", "dump-risk"]));
    expect(isRefundable(r)).toBe(true);
  });

  it("every sub-check failing → HOLD, not GO, not charged", async () => {
    state.rpcDown = true;
    state.goplus = "down";
    state.pairs = "down";
    state.clankerApiDown = true;
    sellabilityMock.mockRejectedValue(new Error("down"));
    swapRouteMock.mockRejectedValue(new Error("down"));
    deployerMock.mockRejectedValue(new Error("down"));
    const r = await preTradeBundle({ address: DEGEN });
    expect(r.decision).not.toBe("GO");
    expect(r.decision).toBe("HOLD");
    expect(r.degraded).toBe(true);
    expect(isRefundable(r)).toBe(true);
    expect(r.receipt.refusal?.reason).toBe("gating_check_unverified");
    // all four gating checks + the informational one are named
    expect(r.unverified.map((u) => u.check).sort()).toEqual(["b20-gate", "clanker-token-audit", "dump-risk", "owner-powers", "pre-trade-gate"]);
    expect(r.sizing.recommendedMaxSizeUsd).toBeNull();
  });

  it("a b20-gate that could not run is unverified, not N/A", async () => {
    // Whole-multicall transport failure: we do not know whether it is a B20.
    state.b20Down = true;
    const r = await preTradeBundle({ address: DEGEN });
    expect(r.checks.b20Gate.status).toBe("unverified");
    expect(r.decision).toBe("HOLD");
    expect(isRefundable(r)).toBe(true);
  });

  it("a DexScreener outage is unverified, never 'no liquidity'", async () => {
    state.pairs = "down";
    const r = await preTradeBundle({ address: DEGEN });
    expect(r.checks.dumpRisk.status).toBe("unverified");
    expect(r.decision).not.toBe("GO");
    expect(isRefundable(r)).toBe(true);
  });

  it("clanker_verified with locked liquidity is a positive note only", async () => {
    wire(V4_TOKEN);
    state.pairs = deepPools(V4_TOKEN);
    const r = await preTradeBundle({ address: V4_TOKEN });
    expect(r.checks.clankerTokenAudit.decision).toBe("clanker_verified");
    expect(r.positives.join(" ")).toMatch(/Clanker v4 .*liquidityLocked: true/);
    expect(r.decision).toBe("GO");
  });

  it("clanker-token-audit failing is listed but does not block GO", async () => {
    // $CLANKER carries v0 bytecode; confirming a v0 launch needs clanker.world,
    // so with it down clanker-token-audit throws (its own not-charged path).
    wire(CLANKER);
    state.clankerApiDown = true;
    state.pairs = deepPools(CLANKER);
    const r = await preTradeBundle({ address: CLANKER });
    const c = r.unverified.find((u) => u.check === "clanker-token-audit");
    expect(c?.gating).toBe(false);
    expect(r.decision).toBe("GO");
    expect(r.receipt.confidence.band).toBe("medium");
    expect(isRefundable(r)).toBe(false);
  });

  it("rejects bad input before any read", async () => {
    await expect(preTradeBundle({ address: "0x123" })).rejects.toThrow(/valid 0x/);
    await expect(preTradeBundle({ address: DEGEN, amountUsd: "banana" })).rejects.toThrow(/positive number/);
  });
});

/**
 * Every field the bundle reads, asserted on the dependency's REAL output. If a
 * dependency renames or drops one, this fails here rather than the bundle
 * silently reading undefined.
 */
describe("pre-trade-bundle — field shapes of each dependency", () => {
  it("pre-trade-gate: decision, tradeSizeUsd, receipt.observedRisks/checks, degraded/unverifiedChecks", async () => {
    const g = await preTradeGate({ address: DEGEN });
    expect(["GO", "HOLD", "STOP"]).toContain(g.decision);
    expect(typeof g.tradeSizeUsd).toBe("number");
    expect(Array.isArray(g.receipt.observedRisks)).toBe(true);
    expect(g.receipt.checks).toHaveProperty("tokenRisk");
    state.goplus = "down";
    const d = await preTradeGate({ address: DEGEN });
    expect(d.degraded).toBe(true);
    expect(Array.isArray(d.unverifiedChecks)).toBe(true);
  });

  it("b20-gate: isB20 + decision N/A off-B20; powers/observedRisks/symbol/variant on B20", async () => {
    const n = await b20Gate({ address: DEGEN });
    expect(n.isB20).toBe(false);
    expect(n.decision).toBe("N/A");
    state.b20 = B20_SEIZE_ARMED;
    const b = (await b20Gate({ address: DEGEN })) as Record<string, unknown>;
    expect(b.isB20).toBe(true);
    expect(b.decision).toBe("STOP");
    expect(b).toHaveProperty("powers");
    expect(Array.isArray(b.observedRisks)).toBe(true);
    expect(b).toHaveProperty("symbol", "SEIZ");
    expect(b).toHaveProperty("variant");
  });

  it("owner-powers: verdict, ownerAddress, ownershipRenounced, renounceIsReal, isOpenSource, severity, powers[].flag/severity", async () => {
    state.goplus = { ...cleanGoPlus(), is_mintable: "1", owner_address: "0x3333333333333333333333333333333333333333" };
    const o = await ownerPowers({ address: DEGEN });
    expect(o.verdict).toBe("limited_controls");
    expect(o.ownerAddress).toBe("0x3333333333333333333333333333333333333333");
    expect(typeof o.ownershipRenounced).toBe("boolean");
    expect(typeof o.renounceIsReal).toBe("boolean");
    expect(o.isOpenSource).toBe(true);
    expect(o.severity).toEqual(expect.objectContaining({ critical: 0, high: 0, medium: 1 }));
    expect(o.powers[0]).toEqual(expect.objectContaining({ flag: "is_mintable", severity: "medium" }));
  });

  it("owner-powers: a row without owner_address reads 'renounced' — the bundle must not call that clean", async () => {
    const { owner_address: _o, ...noOwner } = cleanGoPlus();
    void _o;
    state.goplus = noOwner;
    const o = await ownerPowers({ address: DEGEN });
    expect(o.verdict).toBe("renounced_clean"); // the dependency's own reading
    expect(o.ownerAddress).toBeNull();
    const r = await preTradeBundle({ address: DEGEN });
    expect(r.checks.ownerPowers.status).toBe("unverified");
    expect(r.decision).toBe("HOLD");
  });

  it("dump-risk: verdict, aggregateLiquidityUsd, poolsCounted, marketCapUsd, topDumpableHolder.percentOfSupply, impact pcts", async () => {
    const d = await dumpRiskCore({ address: DEGEN });
    expect(d.verdict).toBe("resilient");
    expect(d.aggregateLiquidityUsd).toBe(4_000_000);
    expect(d.poolsCounted).toBe(1);
    expect(d.marketCapUsd).toBe(10_000_000);
    expect(d.topDumpableHolder?.percentOfSupply).toBe(1);
    expect(typeof d.topHolderDumpImpactPct).toBe("number");
    expect(typeof d.top3DumpImpactPct).toBe("number");
  });

  it("clanker-token-audit: verdict, clankerVersion, liquidityLocked, claimsClanker", async () => {
    const c = await clankerTokenAudit({ address: DEGEN });
    expect(c.verdict).toBe("not_clanker");
    expect(c.clankerVersion).toBeNull();
    expect(c.liquidityLocked).toBeNull();
    expect(c.claimsClanker).toBe(false);
    wire(V4_TOKEN);
    const v = await clankerTokenAudit({ address: V4_TOKEN });
    expect(v.verdict).toBe("clanker_verified");
    expect(v.clankerVersion).toBe("v4");
    expect(v.liquidityLocked).toBe(true);
  });
});
