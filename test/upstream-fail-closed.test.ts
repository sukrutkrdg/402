import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearUpstreamCache, dexTokenPairs, goPlusSecurity } from "@/lib/upstream-cache";

vi.mock("@/lib/kv", () => ({
  kvGet: vi.fn(async () => null),
  kvSet: vi.fn(async () => "OK"),
}));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("upstream reads fail closed", () => {
  beforeEach(() => clearUpstreamCache());
  afterEach(() => vi.restoreAllMocks());

  it("treats a partial GoPlus row (code 3, no is_honeypot) as no answer", async () => {
    const addr = "0xb2000000000000000000004c27f6523082f41d01";
    // Shape GoPlus returned live for a token still being analysed.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ code: 3, result: { [addr]: { is_open_source: "1", owner_address: "", holder_count: "12" } } }),
    );
    expect(await goPlusSecurity(addr)).toBeNull();
  });

  it("keeps a complete GoPlus row", async () => {
    const addr = "0x1111111111111111111111111111111111111111";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: 1, result: { [addr]: { is_honeypot: "0", sell_tax: "0" } } }));
    expect(await goPlusSecurity(addr)).toMatchObject({ is_honeypot: "0" });
  });

  it("drops DexScreener pairs from other chains", async () => {
    // 0x4200…0042 is OP on Optimism and a different contract on Base.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({
        pairs: [
          { chainId: "optimism", pairAddress: "0xop", liquidity: { usd: 546725 } },
          { chainId: "base", pairAddress: "0xbase", liquidity: { usd: 120 } },
          { chainId: "ink", pairAddress: "0xink", liquidity: { usd: 9000 } },
        ],
      }),
    );
    const pairs = await dexTokenPairs<{ pairAddress: string }>("0x4200000000000000000000000000000000000042");
    expect(pairs?.map((p) => p.pairAddress)).toEqual(["0xbase"]);
  });
});
