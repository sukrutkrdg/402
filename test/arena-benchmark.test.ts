import { describe, it, expect } from "vitest";
import { GET, POST, ARENA_CONTENDERS } from "../src/app/api/arena/benchmark/route";

describe("Flow Arena x x402 Benchmark API (/api/arena/benchmark)", () => {
  it("GET returns active contenders, tournament stats, and Base builder code header", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.network).toContain("Base Mainnet");
    expect(json.builderCode).toBe("bc_pa0gqlv1");
    expect(json.summary.totalContenders).toBeGreaterThanOrEqual(5);
    expect(json.summary.totalCareerPrizesUsd).toBeGreaterThan(0);
    expect(json.summary.totalDataSpendUsd).toBeGreaterThan(0);
    expect(Array.isArray(json.contenders)).toBe(true);

    // Verify Champion FADE
    const fade = json.contenders.find((c: { id: string }) => c.id === "fade-champion");
    expect(fade).toBeDefined();
    expect(fade.careerPrizesUsd).toBe(51.0);
    expect(fade.dataSpendUsd).toBe(0.13);
    expect(fade.prizePerDataCent).toBeGreaterThanOrEqual(390);

    // Verify Live Organic Buyer 0xec2a...d034
    const organic = json.contenders.find((c: { id: string }) => c.id === "organic-live-0xec2a");
    expect(organic).toBeDefined();
    expect(organic.wallet.toLowerCase()).toBe("0xec2abd3eda89bed90124736e317e847d5fb6d034".toLowerCase());
    expect(organic.roundsFought).toBe(103);
    expect(organic.status).toBe("ACTIVE_LIVE");
  });

  it("POST simulates an Arena round with EIP-3009 settlement and EAS attestation payload", async () => {
    const req = new Request("http://localhost:3000/api/arena/benchmark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentName: "AlphaSniper-01",
        serviceId: "base-dex-spread",
        dataSpendUsdc: 0.05,
        strategy: "DEX Arbitrage",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.agentName).toBe("AlphaSniper-01");
    expect(json.builderCode).toBe("bc_pa0gqlv1");
    expect(json.settlement.protocol).toBe("x402 (EIP-3009)");
    expect(json.settlement.dataSpendUsdc).toBe(0.05);
    expect(json.settlement.basescanUrl).toContain("https://basescan.org/tx/");
    expect(json.arenaOutcome.prizeWonUsd).toBeGreaterThan(0);
    expect(json.arenaOutcome.signalQualityScore).toBeGreaterThan(90);
    expect(json.easAttestationPayload.schema).toContain("0x402bazaar_arena_skill");
  });

  it("handles empty/malformed POST gracefully with fallback defaults", async () => {
    const req = new Request("http://localhost:3000/api/arena/benchmark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.agentName).toBe("Arena Challenger");
    expect(json.settlement.dataSpendUsdc).toBe(0.02);
  });
});
