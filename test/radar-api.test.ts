import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/radar/route";

describe("Radar API /api/radar", () => {
  it("returns active status and structured arbitrage & security data", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.status).toBe("active");
    expect(data.network).toContain("Base Mainnet");
    expect(data.builderCode).toBe("bc_pa0gqlv1");
    expect(Array.isArray(data.arbitrageSpreads)).toBe(true);
    expect(data.arbitrageSpreads.length).toBeGreaterThan(0);
    expect(Array.isArray(data.securityAlerts)).toBe(true);
    expect(data.securityAlerts.length).toBeGreaterThan(0);

    const firstSpread = data.arbitrageSpreads[0];
    expect(firstSpread.symbol).toBeDefined();
    expect(typeof firstSpread.spreadBps).toBe("number");
    expect(firstSpread.direction).toBeDefined();

    const firstAlert = data.securityAlerts[0];
    expect(firstAlert.type).toBeDefined();
    expect(firstAlert.preventedLossUsd).toBeDefined();
  }, 15000);
});
