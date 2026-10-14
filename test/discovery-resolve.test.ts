import { describe, it, expect } from "vitest";
import { GET, POST } from "../src/app/api/discovery/resolve/route";

describe("Autonomous Semantic Resolver & Niche Service Scout (/api/discovery/resolve)", () => {
  it("GET without query returns catalog stats", async () => {
    const req = new Request("http://localhost:3000/api/discovery/resolve");
    const res = await GET(req as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.totalIndexedServices).toBeGreaterThanOrEqual(200);
  });

  it("GET with semantic query 'honeypot token check' resolves to a token-risk service", async () => {
    const req = new Request("http://localhost:3000/api/discovery/resolve?q=honeypot+token+check");
    const res = await GET(req as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.resolved).toBe(true);
    expect(json.bestMatch).toBeDefined();
    expect(json.bestMatch.confidenceScore).toBeGreaterThan(30);
    expect(json.bestMatch.endpointUrl).toContain("/api/x402/");
    expect(json.directExecutionSnippet.curl).toContain("curl -H");
    expect(json.directExecutionSnippet.typescript).toContain("@x402/fetch");
  });

  it("POST resolves arbitrary natural language agent intent", async () => {
    const req = new Request("http://localhost:3000/api/discovery/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "I need to check cross-chain bridge route from Arbitrum to Base",
      }),
    });

    const res = await POST(req as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.resolved).toBe(true);
    expect(json.bestMatch.serviceId).toMatch(/bridge|swap/);
    expect(json.bestMatch.priceCents).toBeGreaterThan(0);
  });

  it("resolves a prediction-market query to polymarket-odds", async () => {
    const req = new Request("http://localhost:3000/api/discovery/resolve?q=polymarket+prediction+odds");
    const res = await GET(req as any);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.resolved).toBe(true);
    expect(json.bestMatch.serviceId).toBe("polymarket-odds");
  });
});
