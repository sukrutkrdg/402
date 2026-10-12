import { describe, it, expect } from "vitest";
import { GET, POST } from "../src/app/api/workflows/route";
import { NextRequest } from "next/server";

describe("/api/workflows", () => {
  it("GET returns curated agent workflow templates", async () => {
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.templates.length).toBeGreaterThanOrEqual(4);
    expect(data.builderCode).toBe("bc_pa0gqlv1");

    const sniper = data.templates.find((t: any) => t.id === "sniper-guard");
    expect(sniper).toBeDefined();
    expect(sniper.steps.length).toBe(2);
    expect(sniper.codeSnippet.typescript).toContain("x402BazaarClient");
  });

  it("POST executes an atomic multi-step workflow simulation", async () => {
    const req = new NextRequest("http://localhost:3000/api/workflows", {
      method: "POST",
      body: JSON.stringify({
        workflowId: "sniper-guard",
        token: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
      }),
    });

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.workflowId).toBe("sniper-guard");
    expect(data.executionReceipt).toBeDefined();
    expect(data.logs.length).toBeGreaterThan(2);
  });
});
