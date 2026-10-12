import { describe, it, expect } from "vitest";
import { GET } from "../src/app/api/leaderboard/route";

describe("GET /api/leaderboard", () => {
  it("returns structured metrics, top services, and publisher rankings", async () => {
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.summary).toBeDefined();
    expect(data.summary.totalAgentCalls).toBeGreaterThan(1000000);
    expect(data.summary.activeServicesCount).toBeGreaterThan(100);
    expect(data.summary.baseBuilderCode).toBe("bc_pa0gqlv1");
    expect(data.topServices.length).toBe(10);
    expect(data.topPublishers.length).toBeGreaterThan(0);
    expect(data.recentSettlements.length).toBeGreaterThan(0);
  });
});
