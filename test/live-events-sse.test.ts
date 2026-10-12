import { describe, it, expect } from "vitest";
import { GET, SAMPLE_STREAM_EVENTS } from "../src/app/api/events/live/route";

describe("Live Telemetry SSE API (/api/events/live)", () => {
  it("returns JSON telemetry snapshot when called with mode=poll", async () => {
    const req = new Request("http://localhost:3000/api/events/live?mode=poll", {
      headers: { accept: "application/json" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.stream).toBe("x402-live-telemetry");
    expect(json.builderCode).toBe("bc_pa0gqlv1");
    expect(Array.isArray(json.events)).toBe(true);
    expect(json.events.length).toBeGreaterThanOrEqual(4);
    expect(json.telemetry.totalSettled24hUsdc).toBeGreaterThan(0);
  });

  it("returns text/event-stream response when requested without poll mode", async () => {
    const req = new Request("http://localhost:3000/api/events/live", {
      headers: { accept: "text/event-stream" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    // Read initial stream chunks
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (reader) {
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      const decoded = new TextDecoder().decode(value);
      expect(decoded).toContain("event: handshake");
      expect(decoded).toContain("bc_pa0gqlv1");
      reader.cancel();
    }
  });

  it("contains sample events matching required schema (settlement, arbitrage, sentinel)", () => {
    const types = SAMPLE_STREAM_EVENTS.map((e) => e.type);
    expect(types).toContain("settlement");
    expect(types).toContain("arbitrage");
    expect(types).toContain("sentinel");
    expect(types).toContain("workflow");

    const settlement = SAMPLE_STREAM_EVENTS.find((e) => e.type === "settlement");
    expect(settlement?.payload.builderCode).toBe("bc_pa0gqlv1");
    expect(settlement?.payload.network).toContain("Base Mainnet");
  });
});
