import { describe, it, expect, vi, beforeEach } from "vitest";
import { rwaYieldBenchmark, _resetRwaYieldBenchmarkCache } from "@/lib/rwa-yield-benchmark";

beforeEach(() => {
  _resetRwaYieldBenchmarkCache();
  vi.restoreAllMocks();
});

describe("rwa-yield-benchmark", () => {
  it("calculates RWA vs DeFi yield spread and allocation verdict", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { chain: "Base", project: "morpho-blue", symbol: "USDC", apy: 6.2 },
          { chain: "Base", project: "moonwell", symbol: "USDC", apy: 5.8 },
        ],
      }),
    } as Response);

    const res = await rwaYieldBenchmark();
    expect(res.benchmarkRwaRate).toBe("4.85%");
    expect(res.defiUsdcApyNum).toBe(6.0);
    expect(res.spreadBps).toBe(115);
    expect(res.verdict).toBe("defi_favored");
    expect(res.allocationSuggestion.defiPct).toBe(75);
  });

  it("handles rwa_favored when DeFi lending rates fall below Treasury yield", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { chain: "Base", project: "morpho-blue", symbol: "USDC", apy: 3.8 },
          { chain: "Base", project: "moonwell", symbol: "USDC", apy: 3.6 },
        ],
      }),
    } as Response);

    const res = await rwaYieldBenchmark();
    expect(res.spreadBps).toBe(-115);
    expect(res.verdict).toBe("rwa_favored");
    expect(res.allocationSuggestion.rwaPct).toBe(80);
  });
});
