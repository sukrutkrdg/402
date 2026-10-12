import { describe, it, expect } from "vitest";
import { GET, POST } from "../src/app/api/fleet/route";
import { NextRequest } from "next/server";

describe("/api/fleet", () => {
  it("GET returns fleet summary and list of agents", async () => {
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.summary.totalAgents).toBeGreaterThanOrEqual(4);
    expect(data.builderCode).toBe("bc_pa0gqlv1");
    expect(data.agents.length).toBeGreaterThan(0);
  });

  it("POST provisions a new agent into the swarm with scoped spending token", async () => {
    const req = new NextRequest("http://localhost:3000/api/fleet", {
      method: "POST",
      body: JSON.stringify({
        action: "create_agent",
        name: "Test Arbitrage Sub-Agent",
        role: "MEV Searcher",
        dailyCapUsdc: 10.0,
      }),
    });

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.agent.id).toBeDefined();
    expect(data.tokenKey).toContain("x402-flt-");
    expect(data.headerUsage.header).toBe("x-fleet-token");
  });

  it("POST toggles agent status for kill-switch control", async () => {
    const req = new NextRequest("http://localhost:3000/api/fleet", {
      method: "POST",
      body: JSON.stringify({
        action: "toggle_status",
        agentId: "bot-scout-01",
        newStatus: "PAUSED",
      }),
    });

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.newStatus).toBe("PAUSED");
  });
});
